"""scripts/stripe_seed.py against a fake (synchronous) Stripe client — no network.

What matters: a first run builds the whole catalog + portal configuration, a
re-run changes nothing, and a price is only replaced when asked (--reprice).
"""

import itertools
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
import stripe

import scripts.stripe_seed as seed
from packages.billing import catalog
from packages.core.settings import get_settings

KEY = "sk_test_seed"


def _obj(cls: Any, data: dict) -> Any:
    return cls.construct_from(data, KEY)


class SeedFake:
    def __init__(self) -> None:
        self.products: dict[str, dict] = {}
        self.prices: dict[str, dict] = {}
        self.configs: dict[str, dict] = {}
        self.created: list[str] = []
        self._ids = itertools.count(1)
        self.v1 = SimpleNamespace(
            products=SimpleNamespace(
                retrieve=self._product_retrieve, create=self._product_create, update=self._product_update
            ),
            prices=SimpleNamespace(list=self._price_list, create=self._price_create, update=self._price_update),
            billing_portal=SimpleNamespace(
                configurations=SimpleNamespace(
                    list=self._config_list, create=self._config_create, update=self._config_update
                )
            ),
        )

    # products
    def _product_retrieve(self, product_id: str) -> Any:
        if product_id not in self.products:
            raise stripe.InvalidRequestError("No such product", "id", code="resource_missing")
        return _obj(stripe.Product, self.products[product_id])

    def _product_create(self, params: dict) -> Any:
        self.created.append(f"product:{params['id']}")
        self.products[params["id"]] = {"object": "product", "active": True, **params}
        return _obj(stripe.Product, self.products[params["id"]])

    def _product_update(self, product_id: str, params: dict) -> Any:
        self.products[product_id].update(params)
        return _obj(stripe.Product, self.products[product_id])

    # prices
    def _price_list(self, params: dict) -> Any:
        found = [p for p in self.prices.values() if p.get("lookup_key") in params["lookup_keys"]]
        return _obj(stripe.ListObject, {"object": "list", "data": found})

    def _price_create(self, params: dict) -> Any:
        key = params.get("lookup_key")
        holder = next((p for p in self.prices.values() if key and p.get("lookup_key") == key), None)
        if holder is not None:
            if not params.get("transfer_lookup_key"):
                raise stripe.InvalidRequestError("lookup_key already exists", "lookup_key")
            holder["lookup_key"] = None
        price_id = f"price_{next(self._ids)}"
        self.created.append(f"price:{price_id}")
        self.prices[price_id] = {
            "id": price_id,
            "object": "price",
            "active": True,
            "product": params["product"],
            "currency": params["currency"],
            "unit_amount": params["unit_amount"],
            "recurring": params["recurring"],
            "lookup_key": key,
            "metadata": params.get("metadata", {}),
        }
        return _obj(stripe.Price, self.prices[price_id])

    def _price_update(self, price_id: str, params: dict) -> Any:
        self.prices[price_id].update(params)
        return _obj(stripe.Price, self.prices[price_id])

    # portal configurations
    def _config_list(self, params: dict) -> Any:
        data = [{"id": cid, "object": "billing_portal.configuration", **c} for cid, c in self.configs.items()]
        return _obj(stripe.ListObject, {"object": "list", "data": data})

    def _config_create(self, params: dict) -> Any:
        cid = f"bpc_{next(self._ids)}"
        self.created.append(f"config:{cid}")
        self.configs[cid] = dict(params)
        return _obj(stripe.billing_portal.Configuration, {"id": cid, "object": "billing_portal.configuration"})

    def _config_update(self, config_id: str, params: dict) -> Any:
        self.configs[config_id].update(params)
        return _obj(stripe.billing_portal.Configuration, {"id": config_id, "object": "billing_portal.configuration"})


@pytest.fixture
def fake(monkeypatch) -> Iterator[SeedFake]:
    stripe_fake = SeedFake()
    monkeypatch.setenv("STRIPE_SECRET_KEY", KEY)
    monkeypatch.setenv("STRIPE_PORTAL_CONFIGURATION_ID", "")
    monkeypatch.setenv("SITE_URL", "https://site.example.com")
    get_settings.cache_clear()
    monkeypatch.setattr(seed, "build_stripe_client", lambda key, asynchronous: stripe_fake)
    yield stripe_fake
    get_settings.cache_clear()


def _run(monkeypatch, *args: str) -> int:
    monkeypatch.setattr("sys.argv", ["stripe_seed.py", *args])
    return seed.main()


def test_first_run_builds_catalog_and_portal(fake, monkeypatch, capsys):
    assert _run(monkeypatch) == 0

    assert sorted(fake.products) == sorted(p.product_id for p in catalog.PAID_PLANS)
    by_key = {p["lookup_key"]: p for p in fake.prices.values()}
    for plan in catalog.PAID_PLANS:
        price = by_key[plan.lookup_key]
        assert price["product"] == plan.product_id
        assert price["currency"] == "thb"
        assert price["unit_amount"] == plan.mock_unit_amount
        assert price["recurring"] == {"interval": "month", "interval_count": 1}
        assert price["metadata"] == {"noey_tier": plan.tier}

    (config,) = fake.configs.values()
    features = config["features"]
    assert features["invoice_history"] == {"enabled": True}
    assert features["payment_method_update"] == {"enabled": True}
    assert features["subscription_cancel"]["mode"] == "at_period_end"
    update = features["subscription_update"]
    assert update["default_allowed_updates"] == ["price"]
    assert update["proration_behavior"] == "always_invoice"
    assert update["schedule_at_period_end"] == {"conditions": [{"type": "decreasing_item_amount"}]}
    assert [p["product"] for p in update["products"]] == [p.product_id for p in catalog.PAID_PLANS]
    assert [p["prices"] for p in update["products"]] == [
        [by_key[p.lookup_key]["id"]] for p in catalog.PAID_PLANS
    ]
    assert config["default_return_url"] == "https://site.example.com/account/billing"

    out = capsys.readouterr().out
    assert "STRIPE_PORTAL_CONFIGURATION_ID=bpc_" in out
    for event_type in ("checkout.session.completed", "invoice.payment_failed", "customer.updated"):
        assert event_type in out


def test_a_rerun_changes_nothing(fake, monkeypatch):
    assert _run(monkeypatch) == 0
    created = list(fake.created)
    assert _run(monkeypatch) == 0
    assert fake.created == created  # nothing new: same products, prices, config


def test_a_changed_amount_is_kept_unless_repriced(fake, monkeypatch, capsys):
    assert _run(monkeypatch) == 0
    lite_id = next(pid for pid, p in fake.prices.items() if p["lookup_key"] == "noey_lite_monthly")
    fake.prices[lite_id]["unit_amount"] = 25_000  # e.g. the owner set a real price

    assert _run(monkeypatch) == 0
    assert fake.prices[lite_id]["lookup_key"] == "noey_lite_monthly"  # kept
    assert "KEPT" in capsys.readouterr().out

    assert _run(monkeypatch, "--reprice") == 0
    holder = next(p for p in fake.prices.values() if p["lookup_key"] == "noey_lite_monthly")
    assert holder["id"] != lite_id
    assert holder["unit_amount"] == 19_000
    assert fake.prices[lite_id]["active"] is False  # archived, still billing its subscribers
    (config,) = fake.configs.values()
    lite_entry = next(p for p in config["features"]["subscription_update"]["products"]
                      if p["product"] == "noey_lite")
    assert lite_entry["prices"] == [holder["id"]]


@pytest.mark.parametrize(
    ("key", "args"),
    [("", ()), ("pk_test_123", ()), ("rk_live_123", ())],
)
def test_refuses_to_run(fake, monkeypatch, key, args):
    monkeypatch.setenv("STRIPE_SECRET_KEY", key)
    get_settings.cache_clear()
    assert _run(monkeypatch, *args) == 2
    assert fake.created == []


def test_a_live_key_runs_with_the_flag(fake, monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "rk_live_123")
    get_settings.cache_clear()
    assert _run(monkeypatch, "--live") == 0
    assert len(fake.products) == len(catalog.PAID_PLANS)
