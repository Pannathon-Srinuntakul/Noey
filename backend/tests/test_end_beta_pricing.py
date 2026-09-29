"""scripts/end_beta_pricing.py against a fake (synchronous) Stripe client — no network.

The fake answers with REAL stripe-python objects (`construct_from`), so the
script reads them exactly as it reads live responses. The world it builds is the
one that exists on 1 Jan 2027: the catalog lookup key holds the FULL price and
the beta price is archived beside it, keeping its `noey_tier` metadata — which
is how a grandfathered subscription is still recognised as its tier.

What matters: a dry run writes nothing, --apply moves a beta subscription at its
next renewal (never mid-cycle), anything already on the target is skipped, one
Stripe failure does not stop the rest, and pagination reaches past page one.
"""

import itertools
import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
import stripe

import scripts.end_beta_pricing as endbeta
from packages.billing import catalog
from packages.core.settings import get_settings

KEY = "sk_test_endbeta"
PERIOD_END = 1_790_000_000  # well past "now" — the current period has not ended


def _obj(cls: Any, data: dict) -> Any:
    return cls.construct_from(data, KEY)


def _beta_amount(tier: str) -> int:
    """Half the full price — the shape of the owner's beta ladder."""
    plan = catalog.plan_for_tier(tier)
    assert plan is not None
    return plan.mock_unit_amount // 2


class EndBetaFake:
    """The slice of `StripeClient.v1` the script calls, synchronously."""

    def __init__(self) -> None:
        self.prices: dict[str, dict] = {}
        self.subscriptions: list[dict] = []
        self.updates: list[tuple[str, dict, Any]] = []
        self.list_calls: list[dict] = []
        self.fail_on: dict[str, Exception] = {}
        self.page_size: int | None = None
        self._ids = itertools.count(1)
        self.v1 = SimpleNamespace(
            prices=SimpleNamespace(list=self._price_list),
            subscriptions=SimpleNamespace(list=self._sub_list, update=self._sub_update),
        )
        for plan in catalog.PAID_PLANS:
            # What holds the lookup key today (the seed/admin price edit result).
            self.prices[f"price_full_{plan.tier}"] = {
                "id": f"price_full_{plan.tier}",
                "object": "price",
                "active": True,
                "lookup_key": plan.lookup_key,
                "currency": "thb",
                "unit_amount": plan.mock_unit_amount,
                "recurring": {"interval": "month", "interval_count": 1},
                "metadata": {catalog.TIER_METADATA_KEY: plan.tier},
                "product": plan.product_id,
            }
            # The archived beta price: no lookup key any more, tier in metadata.
            self.prices[f"price_beta_{plan.tier}"] = {
                "id": f"price_beta_{plan.tier}",
                "object": "price",
                "active": False,
                "lookup_key": None,
                "currency": "thb",
                "unit_amount": _beta_amount(plan.tier),
                "recurring": {"interval": "month", "interval_count": 1},
                "metadata": {catalog.TIER_METADATA_KEY: plan.tier},
                "product": plan.product_id,
            }

    # ── building subscriptions ────────────────────────────────────────────────

    def add_sub(
        self,
        tier: str = "pro",
        *,
        price_id: str | None = None,
        status: str = "active",
        sub_id: str | None = None,
        schedule: str | None = None,
        pending_update: dict | None = None,
        cancel_at_period_end: bool = False,
        cancel_at: int | None = None,
        quantity: int = 1,
        extra_item: bool = False,
    ) -> str:
        sid = sub_id or f"sub_{next(self._ids)}"
        price = self.prices[price_id or f"price_beta_{tier}"]
        items = [
            {
                "id": f"si_{sid}",
                "object": "subscription_item",
                "current_period_end": PERIOD_END,
                "quantity": quantity,
                "price": price,
            }
        ]
        if extra_item:
            items.append(
                {
                    "id": f"si_{sid}_b",
                    "object": "subscription_item",
                    "current_period_end": PERIOD_END,
                    "quantity": 1,
                    "price": self.prices[f"price_full_{tier}"],
                }
            )
        self.subscriptions.append(
            {
                "id": sid,
                "object": "subscription",
                "customer": f"cus_{sid}",
                "status": status,
                "created": 1_700_000_000 + len(self.subscriptions),
                "cancel_at": cancel_at,
                "cancel_at_period_end": cancel_at_period_end,
                "schedule": schedule,
                "pending_update": pending_update,
                "metadata": {},
                "items": {"object": "list", "data": items},
            }
        )
        return sid

    def price_of(self, sub_id: str) -> str:
        sub = next(s for s in self.subscriptions if s["id"] == sub_id)
        return str(sub["items"]["data"][0]["price"]["id"])

    # ── the API ───────────────────────────────────────────────────────────────

    def _price_list(self, params: dict) -> Any:
        found = [
            p
            for p in self.prices.values()
            if p.get("lookup_key") in params["lookup_keys"]
            and (p["active"] if params.get("active") else True)
        ]
        return _obj(stripe.ListObject, {"object": "list", "data": found})

    def _sub_list(self, params: dict) -> Any:
        self.list_calls.append(dict(params))
        assert "status" not in params  # the default (everything not canceled) is the point
        assert "price" not in params  # filtering by price would break the cursor
        ordered = list(self.subscriptions)
        start = 0
        after = params.get("starting_after")
        if after is not None:
            start = next(i for i, s in enumerate(ordered) if s["id"] == after) + 1
        size = self.page_size or int(params["limit"])
        page = ordered[start : start + size]
        return _obj(
            stripe.ListObject,
            {"object": "list", "data": page, "has_more": start + size < len(ordered)},
        )

    def _sub_update(self, sub_id: str, params: dict, options: Any = None) -> Any:
        self.updates.append((sub_id, dict(params), options))
        if sub_id in self.fail_on:
            raise self.fail_on[sub_id]
        sub = next(s for s in self.subscriptions if s["id"] == sub_id)
        for change in params.get("items", []):
            item = next(i for i in sub["items"]["data"] if i["id"] == change["id"])
            item["price"] = self.prices[change["price"]]
        sub["metadata"] = {**sub["metadata"], **params.get("metadata", {})}
        return _obj(stripe.Subscription, sub)


@pytest.fixture
def fake(monkeypatch) -> Iterator[EndBetaFake]:
    stripe_fake = EndBetaFake()
    monkeypatch.setenv("STRIPE_SECRET_KEY", KEY)
    get_settings.cache_clear()
    monkeypatch.setattr(endbeta, "build_stripe_client", lambda key, asynchronous: stripe_fake)
    monkeypatch.setattr(endbeta, "WRITE_PAUSE_SEC", 0.0)
    yield stripe_fake
    get_settings.cache_clear()


@pytest.fixture
def record(tmp_path):
    return tmp_path / "run.jsonl"


def _run(record, *args: str) -> int:
    return endbeta.main(["--record", str(record), *args])


def _rows(record) -> list[dict]:
    return [json.loads(line) for line in record.read_text(encoding="utf-8").splitlines()]


def _summary(record) -> dict:
    return next(r for r in _rows(record) if r["type"] == "summary")


# ── dry run ───────────────────────────────────────────────────────────────────

def test_dry_run_writes_nothing(fake, record, capsys):
    fake.add_sub("pro")
    fake.add_sub("lite")

    assert _run(record) == 0

    assert fake.updates == []
    assert fake.price_of("sub_1") == "price_beta_pro"
    out = capsys.readouterr().out
    assert "would move" in out
    assert "Dry run: nothing was changed" in out
    summary = _summary(record)
    assert summary["mode"] == "dry-run"
    assert summary["moved"] == 2
    # 99.00 -> 199.00 and 495.00 -> 990.00: the full ladder minus the beta half.
    expected = sum(p.mock_unit_amount - _beta_amount(p.tier) for p in catalog.PAID_PLANS
                   if p.tier in {"pro", "lite"})
    assert summary["monthly_delta_satang"] == expected
    assert all(row.get("applied") is False for row in _rows(record) if row["type"] == "subscription")


# ── apply ─────────────────────────────────────────────────────────────────────

def test_apply_moves_a_beta_subscription_at_the_next_renewal(fake, record):
    sid = fake.add_sub("pro")

    assert _run(record, "--apply") == 0

    (sub_id, params, options) = fake.updates[0]
    assert sub_id == sid
    assert params["items"] == [{"id": f"si_{sid}", "price": "price_full_pro"}]
    # The customer did not ask for this change: nothing may be charged mid-cycle.
    assert params["proration_behavior"] == "none"
    assert params["billing_cycle_anchor"] == "unchanged"
    assert params["metadata"] == {endbeta.MIGRATED_FROM_KEY: "price_beta_pro"}
    assert options == {"idempotency_key": f"noey-end-beta-{sid}-price_full_pro"}
    assert fake.price_of(sid) == "price_full_pro"

    row = next(r for r in _rows(record) if r["type"] == "subscription")
    assert row["applied"] is True
    assert row["before"]["unit_amount"] == _beta_amount("pro")
    assert row["after"]["unit_amount"] == catalog.plan_for_tier("pro").mock_unit_amount


def test_apply_is_idempotent(fake, record):
    sid = fake.add_sub("studio")
    assert _run(record, "--apply") == 0
    assert len(fake.updates) == 1

    assert _run(record, "--apply") == 0
    assert len(fake.updates) == 1  # second run: already on the target, nothing written
    assert fake.price_of(sid) == "price_full_studio"


def test_a_subscription_already_on_the_full_price_is_skipped(fake, record):
    fake.add_sub("pro", price_id="price_full_pro")
    moving = fake.add_sub("lite")

    assert _run(record, "--apply") == 0

    assert [u[0] for u in fake.updates] == [moving]
    skipped = next(r for r in _rows(record) if r["type"] == "subscription" and r["id"] == "sub_1")
    assert skipped["action"] == "skip"
    assert skipped["reason"] == "already on the target price"


def test_trialing_and_past_due_move_but_dead_states_do_not(fake, record):
    trialing = fake.add_sub("pro", status="trialing")
    past_due = fake.add_sub("lite", status="past_due")
    fake.add_sub("pro", status="unpaid")
    fake.add_sub("pro", status="paused")

    assert _run(record, "--apply") == 0

    assert sorted(u[0] for u in fake.updates) == sorted([trialing, past_due])
    reasons = {r["id"]: r["reason"] for r in _rows(record) if r["type"] == "subscription"}
    assert reasons["sub_3"] == "status unpaid: never renews"
    assert reasons["sub_4"] == "status paused: never renews"


def test_states_needing_a_human_are_never_clobbered(fake, record, capsys):
    fake.add_sub("pro", schedule="sub_sched_1")
    fake.add_sub("pro", pending_update={"expires_at": 1})
    fake.add_sub("pro", status="incomplete")
    fake.add_sub("pro", extra_item=True)
    moving = fake.add_sub("lite")

    assert _run(record, "--apply") == 1  # something live was left behind

    assert [u[0] for u in fake.updates] == [moving]
    out = capsys.readouterr().out
    assert "Needs attention" in out
    reasons = {r["id"]: r["reason"] for r in _rows(record) if r["type"] == "subscription"}
    assert "subscription schedule" in reasons["sub_1"]
    assert "pending update" in reasons["sub_2"]
    assert "checkout is still in flight" in reasons["sub_3"]
    assert "2 subscription items" in reasons["sub_4"]
    assert _summary(record)["attention"][0]["id"] == "sub_1"


def test_a_live_subscription_on_an_unknown_price_is_never_guessed_at(fake, record):
    fake.prices["price_legacy"] = {
        "id": "price_legacy", "object": "price", "active": False, "lookup_key": None,
        "currency": "thb", "unit_amount": 12_300,
        "recurring": {"interval": "month", "interval_count": 1},
        "metadata": {}, "product": "prod_legacy",
    }
    fake.add_sub("pro", price_id="price_legacy")

    assert _run(record, "--apply") == 1
    assert fake.updates == []
    assert "maps to no tier" in _summary(record)["attention"][0]["reason"]


def test_a_cancellation_at_period_end_is_left_alone_but_a_later_one_moves(fake, record):
    fake.add_sub("pro", cancel_at_period_end=True)
    fake.add_sub("pro", cancel_at=PERIOD_END)
    later = fake.add_sub("pro", cancel_at=PERIOD_END + 90 * 86_400)  # renews first

    assert _run(record, "--apply") == 0

    assert [u[0] for u in fake.updates] == [later]
    reasons = {r["id"]: r["reason"] for r in _rows(record) if r["type"] == "subscription"}
    assert reasons["sub_1"] == "already ending at the period end: no renewal to reprice"
    assert reasons["sub_2"] == "already ending at the period end: no renewal to reprice"


# ── failures ──────────────────────────────────────────────────────────────────

def test_one_failure_does_not_stop_the_rest_and_shows_in_the_exit_code(fake, record, capsys):
    first = fake.add_sub("lite")
    broken = fake.add_sub("pro")
    last = fake.add_sub("studio")
    fake.fail_on[broken] = stripe.InvalidRequestError(
        "No such subscription item", "items", code="resource_missing"
    )

    assert _run(record, "--apply") == 1

    assert fake.price_of(first) == "price_full_lite"
    assert fake.price_of(last) == "price_full_studio"
    assert fake.price_of(broken) == "price_beta_pro"  # untouched
    out = capsys.readouterr().out
    assert "FAILED" in out and "resource_missing" in out
    assert "re-running this script retries exactly these" in out

    summary = _summary(record)
    assert [f["id"] for f in summary["failures"]] == [broken]
    assert summary["moved"] == 2
    row = next(r for r in _rows(record) if r["type"] == "subscription" and r["id"] == broken)
    assert row["action"] == "failed"
    assert row["error"]["code"] == "resource_missing"
    assert row["applied"] is False

    # And the retry: only the failed one is attempted again.
    fake.fail_on.clear()
    fake.updates.clear()
    assert _run(record, "--apply") == 0
    assert [u[0] for u in fake.updates] == [broken]


# ── pagination ────────────────────────────────────────────────────────────────

def test_pagination_reaches_past_the_first_page(fake, record):
    ids = [fake.add_sub("lite") for _ in range(7)]
    fake.page_size = 3

    assert _run(record, "--apply") == 0

    assert len(fake.list_calls) == 3
    assert fake.list_calls[0].get("starting_after") is None
    assert fake.list_calls[1]["starting_after"] == ids[2]
    assert fake.list_calls[2]["starting_after"] == ids[5]
    assert sorted(u[0] for u in fake.updates) == sorted(ids)


# ── guards ────────────────────────────────────────────────────────────────────

def test_apply_refuses_while_the_lookup_key_still_holds_the_beta_price(fake, record, capsys):
    plan = catalog.plan_for_tier("pro")
    fake.prices["price_full_pro"]["unit_amount"] = _beta_amount("pro")
    fake.add_sub("pro")

    assert _run(record, "--apply") == 2
    assert fake.updates == []
    out = capsys.readouterr().out
    assert "does not hold the catalog amount" in out
    assert plan.lookup_key in out

    # Deliberate (e.g. putting everyone ON the beta price): the flag proceeds.
    assert _run(record, "--apply", "--allow-off-catalog") == 0
    assert len(fake.updates) == 1


def test_check_and_apply_together_are_refused(fake, record):
    assert _run(record, "--check", "--apply") == 2
    assert fake.updates == []


def test_a_missing_catalog_price_refuses_the_run(fake, record, capsys):
    del fake.prices["price_full_agency"]
    fake.add_sub("pro")

    assert _run(record, "--apply") == 2
    assert fake.updates == []
    assert "no active price holds noey_agency_monthly" in capsys.readouterr().out


@pytest.mark.parametrize("key", ["", "pk_test_123"])
def test_a_bad_key_refuses_the_run(fake, record, monkeypatch, key):
    monkeypatch.setenv("STRIPE_SECRET_KEY", key)
    get_settings.cache_clear()
    assert _run(record) == 2
    assert fake.updates == []


def test_a_live_key_needs_the_flag(fake, record, monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "rk_live_123")
    get_settings.cache_clear()
    fake.add_sub("pro")

    assert _run(record, "--apply") == 2
    assert fake.updates == []
    assert _run(record, "--apply", "--live") == 0
    assert len(fake.updates) == 1


def test_tier_and_limit_narrow_a_cautious_first_run(fake, record):
    lite_a = fake.add_sub("lite")
    fake.add_sub("lite")
    fake.add_sub("pro")

    assert _run(record, "--apply", "--tier", "lite", "--limit", "1") == 0
    assert [u[0] for u in fake.updates] == [lite_a]

    assert _run(record, "--tier", "nonsense") == 2


# ── check mode ────────────────────────────────────────────────────────────────

def test_check_counts_what_is_below_the_full_price_and_the_monthly_difference(fake, record, capsys):
    fake.add_sub("pro")
    fake.add_sub("lite")
    fake.add_sub("studio", price_id="price_full_studio")
    fake.add_sub("pro", status="canceled")  # not live: out of the numbers

    assert _run(record, "--check") == 0

    assert fake.updates == []
    out = capsys.readouterr().out
    assert "Live subscriptions: 3" in out
    assert "below the full price      : 2" in out
    summary = _summary(record)
    assert summary["below_full"] == 2
    assert summary["at_full"] == 1
    assert summary["per_tier"] == {"lite": 1, "pro": 1}
    expected = sum(p.mock_unit_amount - _beta_amount(p.tier) for p in catalog.PAID_PLANS
                   if p.tier in {"pro", "lite"})
    assert summary["monthly_delta_satang"] == expected


def test_check_measures_against_the_catalog_while_the_beta_price_is_still_live(fake, record, capsys):
    """The December question: the lookup key still holds the beta price, so
    comparing against it would answer "nothing to do"."""
    for plan in catalog.PAID_PLANS:
        fake.prices[f"price_full_{plan.tier}"]["unit_amount"] = _beta_amount(plan.tier)
    fake.add_sub("pro", price_id="price_full_pro")

    assert _run(record, "--check") == 0

    summary = _summary(record)
    assert summary["below_full"] == 1
    assert summary["monthly_delta_satang"] == (
        catalog.plan_for_tier("pro").mock_unit_amount - _beta_amount("pro")
    )
    assert "do NOT hold the full price yet" in capsys.readouterr().out


def test_check_writes_no_record_unless_asked(fake, record, monkeypatch, tmp_path):
    fake.add_sub("pro")
    written: list = []
    monkeypatch.setattr(endbeta, "default_record_path", lambda *a: written.append(a) or tmp_path / "x")

    assert endbeta.main(["--check"]) == 0
    assert written == []


def test_the_default_record_lands_under_the_gitignored_data_dir():
    import datetime as dt

    path = endbeta.default_record_path("apply", dt.datetime(2027, 1, 1, 9, 30, tzinfo=dt.UTC))
    assert path.parent.parts[-3:] == ("backend", "data", "billing")
    assert path.name == "end-beta-pricing-apply-20270101T093000Z.jsonl"


def test_a_stripe_failure_while_listing_ends_the_run_without_pretending(fake, record, capsys):
    fake.add_sub("pro")

    def boom(params):
        raise stripe.APIConnectionError("network down")

    fake.v1.subscriptions.list = boom
    assert _run(record, "--apply") == 1
    assert "Stripe refused while reading subscriptions" in capsys.readouterr().out
    assert any(r["type"] == "aborted" for r in _rows(record))
