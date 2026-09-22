"""Stripe billing — endpoints, webhook and sync, with no network.

The Stripe client is a fake whose methods return REAL stripe-python objects
(`construct_from`), so the code under test reads them exactly as it reads live
responses. Webhook requests carry real `Stripe-Signature` headers computed here
with HMAC-SHA256 over the raw body. Runs against the local Postgres; every
account uses `@billing.example.com` and is removed afterwards.
"""

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import stripe
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.auth.accounts import create_account
from packages.auth.hashing import hash_password
from packages.auth.tokens import encode_access
from packages.billing import catalog, service
from packages.billing.client import billing_config_problem
from packages.core.settings import Settings, get_settings
from packages.db.session import get_engine, get_sessionmaker
from services.api.main import app
from services.api.routers import billing as billing_router

DOMAIN = "billing.example.com"
API_KEY = "sk_test_fake"
WEBHOOK_SECRET = "whsec_test_secret"
SITE = "https://site.example.com"
PORTAL_CONFIG = "bpc_test"
_HASH = hash_password("irrelevant-password")


# ── Stripe objects ────────────────────────────────────────────────────────────

def _sobj(cls: Any, data: dict) -> Any:
    return cls.construct_from(data, API_KEY)


def _price(tier: str, *, amount: int | None = None, lookup_key: str | None = "catalog") -> dict:
    plan = catalog.plan_for_tier(tier)
    assert plan is not None
    return {
        "id": f"price_{tier}",
        "object": "price",
        "active": True,
        "lookup_key": plan.lookup_key if lookup_key == "catalog" else lookup_key,
        "currency": "thb",
        "unit_amount": plan.mock_unit_amount if amount is None else amount,
        "type": "recurring",
        "recurring": {"interval": "month", "interval_count": 1},
        "metadata": {"noey_tier": tier},
        "product": plan.product_id,
    }


def _sub(
    customer: str,
    tier: str = "pro",
    status: str = "active",
    *,
    sub_id: str | None = None,
    cancel_at: int | None = None,
    cancel_at_period_end: bool = False,
    billing_mode: str = "flexible",
    schedule: str | None = None,
    created: int = 1_700_000_000,
    period_end: int = 1_790_000_000,
    card: tuple[str, str] | None = ("visa", "4242"),
    price: dict | None = None,
) -> dict:
    pm = (
        {"id": "pm_1", "object": "payment_method", "type": "card", "card": {"brand": card[0], "last4": card[1]}}
        if card
        else None
    )
    return {
        "id": sub_id or f"sub_{uuid.uuid4().hex[:8]}",
        "object": "subscription",
        "customer": customer,
        "status": status,
        "created": created,
        "cancel_at": cancel_at,
        "cancel_at_period_end": cancel_at_period_end,
        "billing_mode": {"type": billing_mode},
        "schedule": schedule,
        "metadata": {},
        "default_payment_method": pm,
        "items": {
            "object": "list",
            "data": [
                {
                    "id": "si_1",
                    "object": "subscription_item",
                    "current_period_end": period_end,
                    "price": price or _price(tier),
                }
            ],
        },
    }


class FakeStripe:
    """The slice of `StripeClient.v1` the billing code calls."""

    def __init__(self) -> None:
        self.customers: dict[str, dict] = {}
        self.customer_create_options: list[Any] = []
        self.subscriptions: list[dict] = []
        self.prices = {p.lookup_key: _price(p.tier) for p in catalog.PAID_PLANS}
        self.open_sessions: list[str] = []
        self.expired: list[str] = []
        self.checkout_calls: list[dict] = []
        self.checkout_saw_stored_customer: list[str | None] = []
        self.portal_calls: list[dict] = []
        self.update_calls: list[tuple[str, dict]] = []
        self.released: list[str] = []
        self.sub_list_calls = 0
        self.price_list_calls = 0
        self.v1 = SimpleNamespace(
            customers=SimpleNamespace(
                create_async=self._customer_create, retrieve_async=self._customer_retrieve
            ),
            subscriptions=SimpleNamespace(list_async=self._sub_list, update_async=self._sub_update),
            prices=SimpleNamespace(list_async=self._price_list),
            checkout=SimpleNamespace(
                sessions=SimpleNamespace(
                    create_async=self._checkout_create,
                    list_async=self._checkout_list,
                    expire_async=self._checkout_expire,
                )
            ),
            billing_portal=SimpleNamespace(sessions=SimpleNamespace(create_async=self._portal_create)),
            subscription_schedules=SimpleNamespace(release_async=self._release),
        )

    async def _customer_create(self, params: dict, options: Any = None) -> Any:
        cid = f"cus_fake_{len(self.customers) + 1}"
        self.customers[cid] = {
            "id": cid,
            "object": "customer",
            "email": params["email"],
            "metadata": params.get("metadata", {}),
            "invoice_settings": {"default_payment_method": None},
        }
        self.customer_create_options.append(options)
        return _sobj(stripe.Customer, self.customers[cid])

    async def _customer_retrieve(self, customer_id: str, params: Any = None) -> Any:
        data = self.customers.get(
            customer_id,
            {"id": customer_id, "object": "customer", "invoice_settings": {"default_payment_method": None}},
        )
        return _sobj(stripe.Customer, data)

    async def _sub_list(self, params: dict) -> Any:
        self.sub_list_calls += 1
        assert params["status"] == "all"
        assert params["expand"] == ["data.default_payment_method"]
        subs = [s for s in self.subscriptions if s["customer"] == params["customer"]]
        subs.sort(key=lambda s: s["created"], reverse=True)
        return _sobj(stripe.ListObject, {"object": "list", "data": subs})

    async def _sub_update(self, sub_id: str, params: dict) -> Any:
        self.update_calls.append((sub_id, dict(params)))
        sub = next(s for s in self.subscriptions if s["id"] == sub_id)
        if "cancel_at_period_end" in params:
            sub["cancel_at_period_end"] = params["cancel_at_period_end"]
            sub["cancel_at"] = sub["items"]["data"][0]["current_period_end"] if params["cancel_at_period_end"] else None
        if "cancel_at" in params:
            sub["cancel_at"] = (
                None if params["cancel_at"] == "" else sub["items"]["data"][0]["current_period_end"]
            )
        return _sobj(stripe.Subscription, sub)

    async def _price_list(self, params: dict) -> Any:
        self.price_list_calls += 1
        found = [self.prices[k] for k in params["lookup_keys"] if k in self.prices]
        return _sobj(stripe.ListObject, {"object": "list", "data": found})

    async def _checkout_create(self, params: dict) -> Any:
        self.checkout_calls.append(params)
        # "Store the customer id BEFORE creating the session": look from a
        # separate connection, which only sees committed rows.
        async with get_engine().connect() as conn:
            stored = (
                await conn.execute(
                    text("SELECT stripe_customer_id FROM core.billing_accounts WHERE user_id = :u"),
                    {"u": int(params["client_reference_id"])},
                )
            ).scalar_one_or_none()
        self.checkout_saw_stored_customer.append(stored)
        return _sobj(
            stripe.checkout.Session,
            {"id": "cs_test_1", "object": "checkout.session", "url": "https://checkout.stripe.test/cs_test_1"},
        )

    async def _checkout_list(self, params: dict) -> Any:
        assert params["status"] == "open"
        data = [{"id": sid, "object": "checkout.session"} for sid in self.open_sessions]
        return _sobj(stripe.ListObject, {"object": "list", "data": data})

    async def _checkout_expire(self, session_id: str) -> Any:
        self.expired.append(session_id)
        return _sobj(stripe.checkout.Session, {"id": session_id, "object": "checkout.session"})

    async def _portal_create(self, params: dict) -> Any:
        self.portal_calls.append(params)
        return _sobj(
            stripe.billing_portal.Session,
            {"id": "bps_1", "object": "billing_portal.session", "url": "https://billing.stripe.test/p/1"},
        )

    async def _release(self, schedule_id: str) -> Any:
        self.released.append(schedule_id)
        for sub in self.subscriptions:
            if sub["schedule"] == schedule_id:
                sub["schedule"] = None
        return _sobj(stripe.SubscriptionSchedule, {"id": schedule_id, "object": "subscription_schedule"})


# ── fixtures ──────────────────────────────────────────────────────────────────

async def _purge() -> None:
    async with get_engine().begin() as conn:
        slugs = (
            await conn.execute(
                text(
                    "SELECT t.slug FROM core.tenants t "
                    "JOIN core.memberships m ON m.tenant_id = t.id "
                    "JOIN core.users u ON u.id = m.user_id WHERE u.email LIKE :p"
                ),
                {"p": f"%@{DOMAIN}"},
            )
        ).scalars().all()
        await conn.execute(text("DELETE FROM core.users WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        for slug in slugs:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))
        await conn.execute(text("DELETE FROM core.stripe_events WHERE id LIKE 'evt_test_%'"))


@pytest.fixture(autouse=True)
async def _billing_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", API_KEY)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setenv("STRIPE_PORTAL_CONFIGURATION_ID", PORTAL_CONFIG)
    monkeypatch.setenv("SITE_URL", SITE)
    monkeypatch.setenv("BILLING_AUTOMATIC_TAX", "false")
    get_settings.cache_clear()
    service.reset_plans_cache()
    yield
    app.dependency_overrides.clear()
    await _purge()
    service.reset_plans_cache()
    get_settings.cache_clear()


@pytest.fixture
def fake() -> FakeStripe:
    stripe_fake = FakeStripe()
    app.dependency_overrides[billing_router.stripe_client] = lambda: stripe_fake
    app.dependency_overrides[billing_router.optional_stripe_client] = lambda: stripe_fake
    return stripe_fake


def _unconfigured(monkeypatch) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "")
    get_settings.cache_clear()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _user(*, plan: str = "free", customer: str | None = None) -> tuple[int, dict[str, str]]:
    maker = get_sessionmaker()
    async with maker() as session:
        user, tenant = await create_account(
            session,
            email=f"u-{uuid.uuid4().hex[:10]}@{DOMAIN}",
            password_hash=_HASH,
            display_name="Billing Test",
        )
        user.plan = plan
        await session.commit()
        user_id, tenant_id, slug = int(user.id), int(tenant.id), str(tenant.slug)
    if customer:
        async with get_engine().begin() as conn:
            await conn.execute(
                text("INSERT INTO core.billing_accounts (user_id, stripe_customer_id) VALUES (:u, :c)"),
                {"u": user_id, "c": customer},
            )
    return user_id, {"Authorization": f"Bearer {encode_access(user_id, tenant_id, slug)}"}


async def _row(user_id: int) -> dict[str, Any]:
    async with get_engine().connect() as conn:
        plan = (
            await conn.execute(text("SELECT plan FROM core.users WHERE id = :u"), {"u": user_id})
        ).scalar_one()
        account = (
            await conn.execute(
                text("SELECT * FROM core.billing_accounts WHERE user_id = :u"), {"u": user_id}
            )
        ).mappings().one_or_none()
    return {"plan": plan, "account": dict(account) if account else None}


def _customer() -> str:
    return f"cus_{uuid.uuid4().hex[:10]}"


# ── webhook plumbing ──────────────────────────────────────────────────────────

def _event(event_type: str, obj: dict, *, event_id: str | None = None) -> bytes:
    return json.dumps(
        {
            "id": event_id or f"evt_test_{uuid.uuid4().hex}",
            "object": "event",
            "type": event_type,
            "api_version": "2026-08-26.dahlia",
            "created": int(time.time()),
            "livemode": False,
            "pending_webhooks": 1,
            "request": {"id": None, "idempotency_key": None},
            "data": {"object": obj},
        }
    ).encode("utf-8")


def _signed(payload: bytes, *, secret: str = WEBHOOK_SECRET, timestamp: int | None = None) -> dict:
    ts = int(time.time()) if timestamp is None else timestamp
    signature = hmac.new(
        secret.encode("utf-8"), f"{ts}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return {"Stripe-Signature": f"t={ts},v1={signature}", "Content-Type": "application/json"}


async def _deliver(c: AsyncClient, payload: bytes, **kw: Any) -> Any:
    return await c.post("/billing/webhook", content=payload, headers=_signed(payload, **kw))


# ── configuration ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"stripe_secret_key": None}, "STRIPE_SECRET_KEY is not set"),
        ({"stripe_secret_key": "pk_test_123"}, "restricted rk_ or secret sk_"),
        ({"stripe_webhook_secret": ""}, "STRIPE_WEBHOOK_SECRET is not set"),
        (
            {"postgres_host": "db.railway.internal", "site_url": "http://localhost:3000"},
            "SITE_URL still points at localhost",
        ),
        ({"stripe_secret_key": "rk_test_123"}, None),
    ],
)
def test_billing_config_problem(overrides, expected):
    base = {
        "stripe_secret_key": "sk_test_123",
        "stripe_webhook_secret": "whsec_1",
        "site_url": SITE,
        "postgres_host": "localhost",
    }
    problem = billing_config_problem(Settings(**{**base, **overrides}))
    if expected is None:
        assert problem is None
    else:
        assert problem is not None and expected in problem


async def test_every_billing_action_is_503_when_not_configured(monkeypatch):
    _unconfigured(monkeypatch)
    _, auth = await _user()
    async with _client() as c:
        responses = [
            await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth),
            await c.post("/billing/change-plan", json={"lookup_key": "noey_pro_monthly"}, headers=auth),
            await c.post("/billing/cancel", headers=auth),
            await c.post("/billing/resume", headers=auth),
            await c.post("/billing/portal", headers=auth),
            await c.post("/billing/webhook", content=b"{}"),
        ]
        me = await c.get("/billing/me", headers=auth)
        plans = await c.get("/billing/plans")
    for r in responses:
        assert r.status_code == 503, r.text
        assert "STRIPE_SECRET_KEY" in r.json()["detail"]
    assert me.status_code == 200 and me.json()["billing_enabled"] is False
    assert plans.status_code == 200 and plans.json()["source"] == "mock"


# ── status → plan ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("status", "plan"),
    [
        ("active", "pro"),
        ("trialing", "pro"),
        ("past_due", "pro"),
        ("incomplete", "free"),
        ("incomplete_expired", "free"),
        ("unpaid", "free"),
        ("paused", "free"),
        ("canceled", "free"),
    ],
)
def test_subscription_status_maps_to_plan(status, plan):
    sub = _sobj(stripe.Subscription, _sub("cus_x", "pro", status))
    assert service.plan_for_subscription(sub) == plan


def test_no_subscription_is_free_and_an_unknown_live_price_is_undecided():
    assert service.plan_for_subscription(None) == "free"
    foreign = _price("pro", lookup_key=None)
    foreign["metadata"] = {}
    sub = _sobj(stripe.Subscription, _sub("cus_x", "pro", "active", price=foreign))
    assert service.plan_for_subscription(sub) is None  # never guessed


def test_a_grandfathered_price_keeps_its_tier_through_metadata():
    old = _price("studio", amount=150_000, lookup_key=None)  # its lookup key moved on
    sub = _sobj(stripe.Subscription, _sub("cus_x", "studio", "active", price=old))
    assert service.plan_for_subscription(sub) == "studio"


# ── plans ─────────────────────────────────────────────────────────────────────

async def test_plans_are_mock_without_stripe(monkeypatch):
    _unconfigured(monkeypatch)
    async with _client() as c:
        body = (await c.get("/billing/plans")).json()
    assert body == {
        "source": "mock",
        "currency": "thb",
        "plans": [
            {"tier": "lite", "lookup_key": "noey_lite_monthly", "interval": "month", "unit_amount": 19900},
            {"tier": "starter", "lookup_key": "noey_starter_monthly", "interval": "month", "unit_amount": 39900},
            {"tier": "pro", "lookup_key": "noey_pro_monthly", "interval": "month", "unit_amount": 99000},
            {"tier": "studio", "lookup_key": "noey_studio_monthly", "interval": "month", "unit_amount": 199000},
            {"tier": "agency", "lookup_key": "noey_agency_monthly", "interval": "month", "unit_amount": 399000},
            {"tier": "max", "lookup_key": "noey_max_monthly", "interval": "month", "unit_amount": 699000},
        ],
    }


async def test_plans_come_live_from_stripe_and_are_cached(fake):
    fake.prices["noey_lite_monthly"] = _price("lite", amount=25_000)
    async with _client() as c:
        first = (await c.get("/billing/plans")).json()
        second = (await c.get("/billing/plans")).json()
    assert first["source"] == "stripe"
    assert first["plans"][0] == {
        "tier": "lite", "lookup_key": "noey_lite_monthly", "interval": "month", "unit_amount": 25000,
    }
    assert second == first
    assert fake.price_list_calls == 1


async def test_plans_fall_back_to_mock_when_the_catalog_is_half_seeded(fake):
    del fake.prices["noey_studio_monthly"]
    async with _client() as c:
        body = (await c.get("/billing/plans")).json()
    assert body["source"] == "mock"


# ── /billing/me ───────────────────────────────────────────────────────────────

async def test_me_for_a_new_account(fake):
    _, auth = await _user()
    async with _client() as c:
        body = (await c.get("/billing/me", headers=auth)).json()
    assert body == {
        "plan": "free",
        "status": None,
        "lookup_key": None,
        "current_period_end": None,
        "cancel_at_period_end": False,
        "payment_method": None,
        "billing_enabled": True,
    }


async def test_me_requires_auth():
    async with _client() as c:
        assert (await c.get("/billing/me")).status_code == 401


# ── checkout ──────────────────────────────────────────────────────────────────

async def test_checkout_creates_and_stores_the_customer_before_the_session(fake):
    fake.open_sessions = ["cs_old_tab"]
    user_id, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://checkout.stripe.test/cs_test_1"}

    stored = (await _row(user_id))["account"]
    assert stored is not None
    customer = stored["stripe_customer_id"]
    assert fake.checkout_saw_stored_customer == [customer]  # committed before the session
    assert fake.customers[customer]["metadata"] == {"user_id": str(user_id)}
    assert fake.customer_create_options[0]["idempotency_key"].startswith(f"noey-customer-{user_id}-")
    assert fake.expired == ["cs_old_tab"]  # a second tab can no longer pay

    params = fake.checkout_calls[0]
    assert params["mode"] == "subscription"
    assert params["customer"] == customer
    assert params["client_reference_id"] == str(user_id)
    assert params["line_items"] == [{"price": "price_pro", "quantity": 1}]
    assert params["subscription_data"] == {"metadata": {"user_id": str(user_id)}}
    assert params["allow_promotion_codes"] is True
    assert params["success_url"] == f"{SITE}/checkout/success?session_id={{CHECKOUT_SESSION_ID}}"
    assert params["cancel_url"] == f"{SITE}/pricing?checkout=canceled"
    assert params["integration_identifier"] == catalog.INTEGRATION_IDENTIFIER
    assert "payment_method_types" not in params
    assert "automatic_tax" not in params  # Stripe Tax off by default


async def test_checkout_reuses_the_customer(fake):
    _, auth = await _user()
    async with _client() as c:
        await c.post("/billing/checkout", json={"lookup_key": "noey_lite_monthly"}, headers=auth)
        await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert len(fake.customers) == 1
    assert len({p["customer"] for p in fake.checkout_calls}) == 1


async def test_checkout_with_automatic_tax(fake, monkeypatch):
    monkeypatch.setenv("BILLING_AUTOMATIC_TAX", "true")
    get_settings.cache_clear()
    _, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_lite_monthly"}, headers=auth)
    assert r.status_code == 200
    params = fake.checkout_calls[0]
    assert params["automatic_tax"] == {"enabled": True}
    assert params["customer_update"] == {"address": "auto", "name": "auto"}


async def test_checkout_unknown_lookup_key_is_422(fake):
    _, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_gold_monthly"}, headers=auth)
    assert r.status_code == 422
    assert fake.customers == {}


async def test_checkout_with_a_live_subscription_is_409(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "lite", "past_due")]  # past_due is still live
    user_id, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 409
    assert fake.checkout_calls == []
    assert (await _row(user_id))["plan"] == "lite"  # the lagging mirror was re-synced


async def test_checkout_after_a_cancellation_is_allowed(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro", "canceled")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 200


async def test_checkout_for_an_admin_managed_plan_is_409(fake):
    _, auth = await _user(plan="enterprise")
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 409


async def test_checkout_when_the_price_is_not_seeded_is_503(fake):
    del fake.prices["noey_pro_monthly"]
    _, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/checkout", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 503


# ── change plan ───────────────────────────────────────────────────────────────

async def test_change_plan_without_a_subscription_is_409(fake):
    _, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 409


async def test_change_plan_with_only_a_canceled_subscription_is_409(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "lite", "canceled")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 409


async def test_change_plan_to_the_current_plan_is_409(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "noey_pro_monthly"}, headers=auth)
    assert r.status_code == 409


async def test_change_plan_while_a_change_is_scheduled_is_409(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro", schedule="sub_sched_1")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "noey_lite_monthly"}, headers=auth)
    assert r.status_code == 409


async def test_change_plan_unknown_lookup_key_is_422(fake):
    _, auth = await _user()
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "nope"}, headers=auth)
    assert r.status_code == 422


async def test_change_plan_returns_a_portal_confirm_deep_link(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "lite", sub_id="sub_live")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/change-plan", json={"lookup_key": "noey_studio_monthly"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://billing.stripe.test/p/1"}
    params = fake.portal_calls[0]
    assert params["customer"] == customer
    assert params["configuration"] == PORTAL_CONFIG
    assert params["return_url"] == f"{SITE}/account/billing"
    assert params["flow_data"] == {
        "type": "subscription_update_confirm",
        "subscription_update_confirm": {
            "subscription": "sub_live",
            "items": [{"id": "si_1", "price": "price_studio", "quantity": 1}],
        },
        "after_completion": {
            "type": "redirect",
            "redirect": {"return_url": f"{SITE}/account/billing?plan_change=done"},
        },
    }


# ── cancel / resume ───────────────────────────────────────────────────────────

async def test_cancel_without_a_subscription_is_409(fake):
    _, auth = await _user()
    async with _client() as c:
        assert (await c.post("/billing/cancel", headers=auth)).status_code == 409
        assert (await c.post("/billing/resume", headers=auth)).status_code == 409


async def test_cancel_then_resume_flexible_billing_mode(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro", sub_id="sub_flex", billing_mode="flexible")]
    user_id, auth = await _user(customer=customer)
    async with _client() as c:
        canceled = await c.post("/billing/cancel", headers=auth)
        again = await c.post("/billing/cancel", headers=auth)  # idempotent
        resumed = await c.post("/billing/resume", headers=auth)
        not_scheduled = await c.post("/billing/resume", headers=auth)

    assert canceled.status_code == 200, canceled.text
    body = canceled.json()
    assert body["plan"] == "pro"  # access continues until the period ends
    assert body["cancel_at_period_end"] is True
    assert body["status"] == "active"
    assert body["lookup_key"] == "noey_pro_monthly"
    assert body["current_period_end"].startswith("2026-09-21T")
    assert body["payment_method"] == {"brand": "visa", "last4": "4242"}
    assert again.status_code == 200 and again.json()["cancel_at_period_end"] is True
    assert resumed.status_code == 200 and resumed.json()["cancel_at_period_end"] is False
    assert not_scheduled.status_code == 409
    assert fake.update_calls == [
        ("sub_flex", {"cancel_at": "max_period_end", "expand": ["default_payment_method"]}),
        ("sub_flex", {"cancel_at": "", "expand": ["default_payment_method"]}),
    ]
    assert (await _row(user_id))["plan"] == "pro"


async def test_cancel_then_resume_classic_billing_mode(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "starter", sub_id="sub_classic", billing_mode="classic")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        canceled = await c.post("/billing/cancel", headers=auth)
        resumed = await c.post("/billing/resume", headers=auth)
    assert canceled.json()["cancel_at_period_end"] is True
    assert resumed.json()["cancel_at_period_end"] is False
    assert [params for _, params in fake.update_calls] == [
        {"cancel_at_period_end": True, "expand": ["default_payment_method"]},
        {"cancel_at_period_end": False, "expand": ["default_payment_method"]},
    ]


async def test_cancel_drops_a_scheduled_downgrade_first(fake):
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro", sub_id="sub_s", schedule="sub_sched_9")]
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/cancel", headers=auth)
    assert r.status_code == 200, r.text
    assert fake.released == ["sub_sched_9"]
    assert fake.update_calls[0][0] == "sub_s"


# ── portal ────────────────────────────────────────────────────────────────────

async def test_portal_before_any_checkout_is_409(fake):
    _, auth = await _user()
    async with _client() as c:
        assert (await c.post("/billing/portal", headers=auth)).status_code == 409


async def test_portal(fake):
    customer = _customer()
    _, auth = await _user(customer=customer)
    async with _client() as c:
        r = await c.post("/billing/portal", headers=auth)
    assert r.status_code == 200 and r.json() == {"url": "https://billing.stripe.test/p/1"}
    assert fake.portal_calls == [
        {"customer": customer, "return_url": f"{SITE}/account/billing", "configuration": PORTAL_CONFIG}
    ]


# ── webhook ───────────────────────────────────────────────────────────────────

async def test_webhook_rejects_bad_missing_and_stale_signatures(fake):
    payload = _event("customer.subscription.updated", _sub("cus_x"))
    async with _client() as c:
        wrong_secret = await _deliver(c, payload, secret="whsec_someone_else")
        stale = await _deliver(c, payload, timestamp=int(time.time()) - 3600)
        missing = await c.post("/billing/webhook", content=payload)
        tampered = await c.post(
            "/billing/webhook", content=payload + b" ", headers=_signed(payload)
        )
    for r in (wrong_secret, stale, missing, tampered):
        assert r.status_code == 400, r.text
    assert fake.sub_list_calls == 0


async def test_webhook_syncs_the_plan_from_stripe(fake):
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "pro", sub_id="sub_1", period_end=1_790_000_000)]
    async with _client() as c:
        r = await _deliver(c, _event("customer.subscription.created", fake.subscriptions[0]))
    assert r.status_code == 200 and r.json() == {"status": "synced"}
    row = await _row(user_id)
    assert row["plan"] == "pro"
    account = row["account"]
    assert account["stripe_subscription_id"] == "sub_1"
    assert account["status"] == "active"
    assert account["price_lookup_key"] == "noey_pro_monthly"
    assert int(account["current_period_end"].timestamp()) == 1_790_000_000
    assert (account["pm_brand"], account["pm_last4"]) == ("visa", "4242")


async def test_webhook_is_idempotent_per_event_id(fake):
    customer = _customer()
    await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "lite")]
    payload = _event("invoice.paid", {"id": "in_1", "object": "invoice", "customer": customer})
    async with _client() as c:
        first = await _deliver(c, payload)
        second = await _deliver(c, payload)
    assert first.json() == {"status": "synced"}
    assert second.status_code == 200 and second.json() == {"status": "duplicate"}
    assert fake.sub_list_calls == 1


async def test_concurrent_redelivery_is_processed_once(fake):
    """The second insert of the same event id waits on the first transaction's
    uncommitted row, then sees the conflict — one sync, one duplicate."""
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "studio")]
    slow_list = fake.v1.subscriptions.list_async

    async def slow(params: dict) -> Any:
        await asyncio.sleep(0.2)  # hold the first transaction open
        return await slow_list(params)

    fake.v1.subscriptions.list_async = slow
    payload = _event("customer.subscription.updated", fake.subscriptions[0])
    async with _client() as c:
        first, second = await asyncio.gather(_deliver(c, payload), _deliver(c, payload))
    assert sorted([first.json()["status"], second.json()["status"]]) == ["duplicate", "synced"]
    assert fake.sub_list_calls == 1
    assert (await _row(user_id))["plan"] == "studio"


@pytest.mark.parametrize(
    ("event_type", "status", "plan"),
    [
        ("invoice.payment_failed", "past_due", "starter"),  # dunning keeps access
        ("customer.subscription.paused", "paused", "free"),
        ("customer.subscription.updated", "unpaid", "free"),
        ("customer.subscription.deleted", "canceled", "free"),
    ],
)
async def test_webhook_status_transitions(fake, event_type, status, plan):
    customer = _customer()
    user_id, _ = await _user(plan="starter", customer=customer)
    fake.subscriptions = [_sub(customer, "starter", status)]
    obj = (
        {"id": "in_2", "object": "invoice", "customer": customer}
        if event_type.startswith("invoice.")
        else fake.subscriptions[0]
    )
    async with _client() as c:
        r = await _deliver(c, _event(event_type, obj))
    assert r.json() == {"status": "synced"}
    row = await _row(user_id)
    assert row["plan"] == plan
    assert row["account"]["status"] == status
    if plan == "free":
        assert row["account"]["pm_brand"] is None


async def test_webhook_never_overrides_an_admin_granted_enterprise_plan(fake):
    customer = _customer()
    user_id, _ = await _user(plan="enterprise", customer=customer)
    fake.subscriptions = [_sub(customer, "lite")]
    async with _client() as c:
        await _deliver(c, _event("customer.subscription.updated", fake.subscriptions[0]))
    assert (await _row(user_id))["plan"] == "enterprise"


async def test_webhook_prefers_the_highest_live_tier(fake):
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [
        _sub(customer, "lite", created=1_700_000_500),
        _sub(customer, "studio", created=1_700_000_000),
        _sub(customer, "pro", "canceled", created=1_700_000_900),
    ]
    async with _client() as c:
        await _deliver(c, _event("customer.subscription.updated", fake.subscriptions[0]))
    assert (await _row(user_id))["plan"] == "studio"


async def test_checkout_completed_unpaid_waits_for_the_payment(fake):
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    session_obj = {
        "id": "cs_1", "object": "checkout.session", "mode": "subscription",
        "payment_status": "unpaid", "customer": customer,
    }
    async with _client() as c:
        r = await _deliver(c, _event("checkout.session.completed", session_obj))
    assert r.json() == {"status": "awaiting_payment"}
    assert fake.sub_list_calls == 0
    assert (await _row(user_id))["plan"] == "free"


async def test_async_payment_succeeded_syncs(fake):
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "lite")]
    session_obj = {
        "id": "cs_2", "object": "checkout.session", "mode": "subscription",
        "payment_status": "paid", "customer": customer,
    }
    async with _client() as c:
        r = await _deliver(c, _event("checkout.session.async_payment_succeeded", session_obj))
    assert r.json() == {"status": "synced"}
    assert (await _row(user_id))["plan"] == "lite"


async def test_unknown_customer_is_acknowledged_not_retried(fake):
    async with _client() as c:
        r = await _deliver(
            c, _event("customer.subscription.updated", _sub("cus_nobody_knows", "pro"))
        )
    assert r.status_code == 200 and r.json() == {"status": "unknown_customer"}


async def test_metadata_is_only_a_fallback_for_an_unstored_customer(fake):
    """The customer id is normally stored before checkout; client_reference_id
    rescues the one case where that write was lost."""
    user_id, _ = await _user()  # no billing row
    customer = _customer()
    fake.subscriptions = [_sub(customer, "pro")]
    session_obj = {
        "id": "cs_3", "object": "checkout.session", "mode": "subscription",
        "payment_status": "paid", "customer": customer, "client_reference_id": str(user_id),
    }
    async with _client() as c:
        r = await _deliver(c, _event("checkout.session.completed", session_obj))
    assert r.json() == {"status": "synced"}
    row = await _row(user_id)
    assert row["plan"] == "pro"
    assert row["account"]["stripe_customer_id"] == customer


async def test_metadata_never_steals_a_user_already_bound_to_another_customer(fake):
    stored = _customer()
    user_id, _ = await _user(customer=stored)
    stranger = _customer()
    fake.subscriptions = [_sub(stranger, "studio")]
    obj = _sub(stranger, "studio")
    obj["metadata"] = {"user_id": str(user_id)}
    async with _client() as c:
        r = await _deliver(c, _event("customer.subscription.created", obj))
    assert r.json() == {"status": "unknown_customer"}
    row = await _row(user_id)
    assert row["plan"] == "free"
    assert row["account"]["stripe_customer_id"] == stored


async def test_card_change_in_the_portal_reaches_the_account(fake):
    """The portal sets the CUSTOMER default and may clear the subscription's."""
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "pro", card=None)]
    fake.customers[customer] = {
        "id": customer,
        "object": "customer",
        "invoice_settings": {
            "default_payment_method": {
                "id": "pm_2", "object": "payment_method", "type": "card",
                "card": {"brand": "mastercard", "last4": "4444"},
            }
        },
    }
    async with _client() as c:
        r = await _deliver(c, _event("customer.updated", fake.customers[customer]))
    assert r.json() == {"status": "synced"}
    account = (await _row(user_id))["account"]
    assert (account["pm_brand"], account["pm_last4"]) == ("mastercard", "4444")


async def test_unhandled_event_types_are_acknowledged(fake):
    async with _client() as c:
        r = await _deliver(c, _event("charge.refunded", {"id": "ch_1", "object": "charge"}))
    assert r.status_code == 200 and r.json() == {"status": "ignored"}


async def test_a_stripe_failure_is_a_retryable_500_and_not_marked_processed(fake):
    customer = _customer()
    user_id, _ = await _user(customer=customer)
    fake.subscriptions = [_sub(customer, "pro")]

    async def boom(params: dict) -> Any:
        raise stripe.APIConnectionError("network down")

    working = fake.v1.subscriptions.list_async
    fake.v1.subscriptions.list_async = boom
    payload = _event("customer.subscription.updated", fake.subscriptions[0])
    async with _client() as c:
        failed = await _deliver(c, payload)
        fake.v1.subscriptions.list_async = working
        retried = await _deliver(c, payload)  # Stripe's redelivery of the same event
    assert failed.status_code == 500
    assert retried.json() == {"status": "synced"}
    assert (await _row(user_id))["plan"] == "pro"
