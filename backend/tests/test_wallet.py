"""The top-up wallet: lots, FIFO debits, refunds, expiry, purchase paths."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from packages.billing import rate_card, topup, wallet, webhooks
from packages.billing.accounts import lock_account
from packages.db.session import get_sessionmaker
from services.api.main import app
from services.api.routers import wallet as wallet_router
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=UTC)


async def _session():
    s = get_sessionmaker()()
    await s.execute(text("SET search_path TO core, public"))
    return s


def test_baht_rounding_never_favours_us_twice():
    assert wallet.satang_for_tokens(1) == 1  # 0.035 satang → rounded UP to 1
    assert wallet.satang_for_tokens(1_000_000) == rate_card.TOPUP_SATANG_PER_1M
    assert wallet.tokens_for_satang(35_000) == 1_000_000
    assert wallet.tokens_for_satang(1) == 28  # rounded DOWN


async def test_debits_take_the_lot_closest_to_expiry_first_and_refund_back():
    uid = await make_user(email("wallet"))
    s = await _session()
    old = await wallet.credit(s, uid, 10_000, source="mock", now=NOW - timedelta(days=300))
    new = await wallet.credit(s, uid, 30_000, source="mock", now=NOW)
    acct = await lock_account(s, uid)
    taken = await wallet.debit(s, acct, 15_000, now=NOW)
    await s.commit()
    assert taken == 15_000
    lots = dict(await db("SELECT id, remaining_satang FROM core.wallet_lots WHERE user_id = :u", u=uid))
    assert lots[old.id] == 0 and lots[new.id] == 25_000
    assert await wallet.balance(s, uid, NOW) == 25_000

    # A debit never goes below zero.
    acct = await lock_account(s, uid)
    assert await wallet.debit(s, acct, 99_999, now=NOW) == 25_000
    await s.commit()
    await s.close()


async def test_refund_returns_a_runs_baht_to_its_lots():
    uid = await make_user(email("wallet"))
    run_id = "a" * 32
    tid = (await db("SELECT tenant_id FROM core.memberships WHERE user_id = :u", u=uid))[0][0]
    await db(
        "INSERT INTO core.ai_runs (id, user_id, tenant_id, kind) VALUES (:r, :u, :t, 'analyze_video')",
        r=run_id, u=uid, t=tid,
    )
    s = await _session()
    await wallet.credit(s, uid, 10_000, source="mock", now=NOW)
    acct = await lock_account(s, uid)
    await wallet.debit(s, acct, 4_000, run_id=run_id, now=NOW)
    refunded = await wallet.refund(s, acct, run_id, now=NOW)
    again = await wallet.refund(s, acct, run_id, now=NOW)
    await s.commit()
    assert (refunded, again) == (4_000, 0)
    assert await wallet.balance(s, uid, NOW) == 10_000
    await s.close()


async def test_lots_expire_after_twelve_months():
    uid = await make_user(email("wallet"))
    s = await _session()
    lot = await wallet.credit(s, uid, 10_000, source="mock", now=NOW)
    assert lot.expires_at == NOW + timedelta(days=365)
    await s.commit()
    assert await wallet.expire_due(s, NOW + timedelta(days=364)) == 0
    assert await wallet.expire_due(s, NOW + timedelta(days=366)) >= 1
    await s.commit()
    assert await wallet.balance(s, uid, NOW + timedelta(days=366)) == 0
    kinds = [r[0] for r in await db("SELECT kind FROM core.wallet_ledger WHERE user_id = :u ORDER BY id", u=uid)]
    assert kinds == ["purchase", "expire"]
    await s.close()


# ── buying ───────────────────────────────────────────────────────────────────

def test_the_checkout_is_a_one_time_thb_payment_for_one_pack():
    params = topup.checkout_params(7, 30_000, "promptpay", "cus_1")
    assert params["mode"] == "payment" and params["payment_method_types"] == ["promptpay"]
    item = params["line_items"][0]["price_data"]
    assert (item["currency"], item["unit_amount"]) == ("thb", 30_000)
    assert params["metadata"] == {"noey_topup": "30000", "user_id": "7", "method": "promptpay"}
    assert "topup=success" in params["success_url"] and "{CHECKOUT_SESSION_ID}" in params["success_url"]
    with pytest.raises(ValueError):
        topup.validate(12_345, "promptpay")
    with pytest.raises(ValueError):
        topup.validate(10_000, "bitcoin")


@pytest.fixture
def mock_topup(monkeypatch):
    from packages.core.settings import get_settings

    monkeypatch.setenv("WALLET_MOCK_TOPUP", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_a_local_machine_without_stripe_credits_a_mock_pack(mock_topup):
    uid = await make_user(email("wallet"))
    async with client() as c:
        h = bearer(await user_token(uid))
        r = await c.post("/wallet/checkout", json={"pack_satang": 30_000, "method": "promptpay"}, headers=h)
        me = (await c.get("/wallet/me", headers=h)).json()
        bad = await c.post("/wallet/checkout", json={"pack_satang": 12_345}, headers=h)
    assert r.status_code == 200 and "topup=success" in r.json()["url"]
    assert me["balance_satang"] == 30_000 and me["packs"] == [10_000, 30_000, 50_000, 100_000]
    assert me["methods"][0] == "promptpay" and me["history"][0]["kind"] == "purchase"
    assert not any("token" in k for k in me)
    assert bad.status_code == 422


@pytest.mark.parametrize(
    ("flag", "host"),
    [
        ("false", "localhost"),  # no explicit opt-in
        ("true", "postgres"),  # a docker-compose deployment is not "this machine"
        ("true", "db"),
        ("true", "10.0.0.5"),
    ],
)
async def test_without_stripe_the_mock_needs_opt_in_and_loopback(monkeypatch, flag, host):
    """Regression: 'the DB host looks local' also matched compose service
    names, so a self-hosted deployment without Stripe keys minted balance."""
    from packages.core.settings import get_settings

    monkeypatch.setenv("WALLET_MOCK_TOPUP", flag)
    get_settings.cache_clear()
    # Only topup's view of the host changes; the test's own database stays put.
    seen_by_topup = get_settings().model_copy(update={"postgres_host": host})
    monkeypatch.setattr(topup, "get_settings", lambda: seen_by_topup)
    assert topup.mock_allowed() is False
    uid = await make_user(email("wallet"))
    async with client() as c:
        r = await c.post("/wallet/checkout", json={"pack_satang": 10_000, "method": "card"},
                         headers=bearer(await user_token(uid)))
    get_settings.cache_clear()
    assert r.status_code == 503
    assert await db("SELECT 1 FROM core.wallet_lots WHERE user_id = :u", u=uid) == []


def test_startup_refuses_the_mock_on_a_real_deployment(monkeypatch):
    from packages.core import settings as settings_mod

    real = settings_mod.get_settings().model_copy(update={
        "wallet_mock_topup": True, "postgres_host": "prod-db.internal", "jwt_secret": "x" * 48,
        "postgres_password": "a-real-password",
    })
    monkeypatch.setenv("ADMIN_PASSWORD", "another-real-password")
    monkeypatch.setattr(settings_mod, "get_settings", lambda: real)
    with pytest.raises(settings_mod.InsecureConfiguration, match="WALLET_MOCK_TOPUP"):
        settings_mod.assert_production_secrets()


async def test_with_stripe_the_checkout_url_comes_from_stripe():
    captured: dict = {}

    class Sessions:
        async def create_async(self, params):
            captured.update(params)
            return SimpleNamespace(url="https://checkout.stripe.test/pay")

    fake = SimpleNamespace(v1=SimpleNamespace(checkout=SimpleNamespace(sessions=Sessions())))
    app.dependency_overrides[wallet_router.optional_stripe] = lambda: fake
    try:
        uid = await make_user(email("wallet"))
        async with client() as c:
            r = await c.post("/wallet/checkout", json={"pack_satang": 50_000, "method": "card"},
                             headers=bearer(await user_token(uid)))
    finally:
        app.dependency_overrides.pop(wallet_router.optional_stripe, None)
    assert r.json() == {"url": "https://checkout.stripe.test/pay"}
    assert captured["payment_method_types"] == ["card"] and captured["customer_email"].endswith("example.com")
    assert await db("SELECT 1 FROM core.wallet_lots WHERE user_id = :u", u=uid) == []  # credited by webhook only


def _event(event_id: str, kind: str, obj: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(id=event_id, type=kind, data=SimpleNamespace(object=obj))


async def test_the_webhook_credits_a_paid_top_up_exactly_once():
    uid = await make_user(email("wallet"))
    sid = f"cs_test_{uid}"
    obj = SimpleNamespace(
        id=sid, object="checkout.session", mode="payment", payment_status="paid", amount_total=10_000,
        client_reference_id=str(uid), payment_method_types=["promptpay"],
        metadata={"noey_topup": "10000", "user_id": str(uid), "method": "promptpay"},
    )
    unpaid = SimpleNamespace(**{**obj.__dict__, "payment_status": "unpaid"})
    outcomes = []
    for event in (
        _event(f"evt_a_{uid}", "checkout.session.completed", unpaid),
        _event(f"evt_b_{uid}", "checkout.session.async_payment_succeeded", obj),
        _event(f"evt_c_{uid}", "checkout.session.completed", obj),
    ):
        s = await _session()
        outcomes.append(await webhooks.handle_event(s, None, event))
        await s.close()
    assert outcomes == ["topup_awaiting_payment", "topup_credited", "topup_duplicate"]
    lots = await db("SELECT amount_satang, source, payment_method FROM core.wallet_lots WHERE user_id = :u", u=uid)
    assert [tuple(r) for r in lots] == [(10_000, "stripe", "promptpay")]
    await db("DELETE FROM core.stripe_events WHERE id LIKE :p", p=f"evt_%_{uid}")


# ── money coming back: Stripe refunds and disputes ───────────────────────────

async def _stripe_lot(uid: int, pi: str, satang: int = 30_000, *, stored_pi: bool = True) -> int:
    s = await _session()
    lot = await wallet.credit(
        s, uid, satang, source="stripe", stripe_session_id=f"cs_{pi}",
        stripe_payment_intent=pi if stored_pi else None,
    )
    await s.commit()
    await s.close()
    return int(lot.id)


async def _deliver(event_id: str, kind: str, obj: SimpleNamespace, client=None) -> str:
    s = await _session()
    try:
        return await webhooks.handle_event(s, client, _event(event_id, kind, obj))
    finally:
        await s.close()


async def _balance(uid: int) -> int:
    s = await _session()
    try:
        return await wallet.balance(s, uid)
    finally:
        await s.close()


def test_refunds_and_disputes_are_handled_events():
    assert {"charge.refunded", "charge.dispute.created", "checkout.session.async_payment_failed"} <= set(
        webhooks.HANDLED_EVENTS
    )


async def test_the_webhook_credit_remembers_the_payment_intent():
    uid = await make_user(email("wallet"))
    obj = SimpleNamespace(
        id=f"cs_pi_{uid}", object="checkout.session", mode="payment", payment_status="paid", amount_total=10_000,
        client_reference_id=str(uid), payment_method_types=["card"], payment_intent=f"pi_{uid}",
        metadata={"noey_topup": "10000", "user_id": str(uid), "method": "card"},
    )
    assert await _deliver(f"evt_pi_{uid}", "checkout.session.completed", obj) == "topup_credited"
    rows = await db("SELECT stripe_payment_intent FROM core.wallet_lots WHERE user_id = :u", u=uid)
    assert rows[0][0] == f"pi_{uid}"
    await db("DELETE FROM core.stripe_events WHERE id = :e", e=f"evt_pi_{uid}")


async def test_a_refunded_top_up_is_taken_back_partially_then_fully():
    uid = await make_user(email("wallet"))
    pi = f"pi_refund_{uid}"
    await _stripe_lot(uid, pi, 30_000)
    charge = SimpleNamespace(object="charge", payment_intent=pi, amount_refunded=10_000)
    first = await _deliver(f"evt_r1_{uid}", "charge.refunded", charge)
    after_partial = await _balance(uid)
    charge2 = SimpleNamespace(object="charge", payment_intent=pi, amount_refunded=30_000)  # cumulative
    second = await _deliver(f"evt_r2_{uid}", "charge.refunded", charge2)
    again = await _deliver(f"evt_r2_{uid}", "charge.refunded", charge2)  # redelivered
    assert (first, second, again) == ("topup_reversed", "topup_reversed", "duplicate")
    assert after_partial == 20_000 and await _balance(uid) == 0
    kinds = [tuple(r) for r in await db(
        "SELECT kind, amount_satang FROM core.wallet_ledger WHERE user_id = :u ORDER BY id", u=uid)]
    assert kinds == [("purchase", 30_000), ("reversal", -10_000), ("reversal", -20_000)]
    await db("DELETE FROM core.stripe_events WHERE id LIKE :p", p=f"evt_r%_{uid}")


async def test_a_dispute_of_a_spent_top_up_takes_what_is_left_and_flags_the_rest():
    uid = await make_user(email("wallet"))
    pi = f"pi_dispute_{uid}"
    await _stripe_lot(uid, pi, 30_000)
    s = await _session()
    account = await lock_account(s, uid)
    await wallet.debit(s, account, 25_000)  # already spent on runs
    await s.commit()
    await s.close()
    dispute = SimpleNamespace(object="dispute", payment_intent=pi, amount=30_000, charge="ch_1")
    out = await _deliver(f"evt_d_{uid}", "charge.dispute.created", dispute)
    assert out == "topup_reversed_short" and await _balance(uid) == 0
    flagged = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'topup_reversal_shortfall' AND target_user_id = :u",
        u=uid,
    )
    assert flagged[0][0]["shortfall_satang"] == 25_000 and flagged[0][0]["taken_satang"] == 5_000
    await db("DELETE FROM core.stripe_events WHERE id = :e", e=f"evt_d_{uid}")


async def test_a_lot_credited_before_the_intent_was_stored_is_found_through_stripe():
    uid = await make_user(email("wallet"))
    pi = f"pi_old_{uid}"
    await _stripe_lot(uid, pi, 10_000, stored_pi=False)
    asked: dict = {}

    class Sessions:
        async def list_async(self, params):
            asked.update(params)
            return SimpleNamespace(data=[SimpleNamespace(id=f"cs_{pi}")])

    fake = SimpleNamespace(v1=SimpleNamespace(checkout=SimpleNamespace(sessions=Sessions())))
    charge = SimpleNamespace(object="charge", payment_intent=pi, amount_refunded=10_000)
    assert await _deliver(f"evt_o_{uid}", "charge.refunded", charge, client=fake) == "topup_reversed"
    assert asked == {"payment_intent": pi, "limit": 1} and await _balance(uid) == 0
    rows = await db("SELECT stripe_payment_intent FROM core.wallet_lots WHERE user_id = :u", u=uid)
    assert rows[0][0] == pi
    await db("DELETE FROM core.stripe_events WHERE id = :e", e=f"evt_o_{uid}")


async def test_a_refund_of_something_that_is_not_a_top_up_changes_nothing():
    uid = await make_user(email("wallet"))
    await _stripe_lot(uid, f"pi_keep_{uid}", 10_000)
    charge = SimpleNamespace(object="charge", payment_intent=f"pi_subscription_{uid}", amount_refunded=99_000)
    assert await _deliver(f"evt_n_{uid}", "charge.refunded", charge) == "topup_not_topup"
    assert await _balance(uid) == 10_000
    failed = SimpleNamespace(id=f"cs_f_{uid}", object="checkout.session", mode="payment", payment_status="unpaid")
    assert await _deliver(f"evt_f_{uid}", "checkout.session.async_payment_failed", failed) == "payment_failed"
    await db("DELETE FROM core.stripe_events WHERE id LIKE :p", p=f"evt_%_{uid}")
