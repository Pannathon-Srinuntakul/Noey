"""What a user sees of their limits: GET /usage/me and POST /usage/estimate.

Percentages, reset times (UTC ISO) and baht — never a token count anywhere
in the body (docs/token-billing-plan.md §1).
"""

from datetime import UTC, datetime

from sqlalchemy import text

from packages.billing import limits, runs, wallet
from packages.db.session import get_sessionmaker
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


async def _me(uid: int) -> dict:
    async with client() as c:
        r = await c.get("/usage/me", headers=bearer(await user_token(uid)))
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_fresh_paid_account_sees_its_empty_windows():
    """limits.py rule 1: Lite/Starter show their month; Pro and up the month
    AND the 40 % week beside it (owner, 2026-10-01). A week nobody has
    started yet has no reset time ("7 days from the next use")."""
    lite = await _me(await make_user(email("usage"), plan="starter"))
    assert [w["key"] for w in lite["limits"]] == ["monthly"]
    uid = await make_user(email("usage"), plan="studio")
    me = await _me(uid)
    assert me["plan"] == "studio" and me["unlimited"] is False
    assert [(w["key"], w["label"], w["used_pct"], w["active"], w["resets_at"], w["resets"])
            for w in me["limits"]] == [
        ("monthly", "Monthly limit", 0.0, False, None, True),
        ("weekly", "Weekly limit", 0.0, False, None, True),
    ]
    assert me["blocked"] is None and me["wallet"] is None and me["pending_plan"] is None
    assert me["concurrency"] == {"max": limits.plan_limits("studio").concurrency, "running": 0, "queued": 0}
    assert me["storage"]["quota_bytes"] == limits.plan_limits("studio").storage_gb * 1024**3
    assert [t["task"] for t in me["by_task"]] == ["cut", "effects", "style", "other"]
    # Compat fields the marketing site's account pages read.
    assert me["usage_pct"] == 0.0 and me["period_start"].endswith("Z") and me["reset_at"] is None
    assert not any("token" in k for k in _keys(me)), sorted(_keys(me))


async def test_used_windows_show_percent_reset_time_and_block_when_full():
    """Lite enforces its monthly budget only (limits.py says why), and the
    month is the SUBSCRIPTION's: a customer billed on the 15th counts down to
    the 15th, whenever in the cycle they happened to start cutting."""
    uid = await make_user(email("usage"), plan="lite")
    [key] = limits.plan_limits("lite").windows
    assert key == "monthly"
    monthly = limits.window_limit("lite", key)
    now = datetime.now(UTC)
    period_start = runs.period_start(now, 15)
    start, refills = runs.iso(period_start), runs.iso(runs.period_end(now, 15))
    await db(
        "INSERT INTO core.usage_accounts "
        "(user_id, monthly_anchor_day, monthly_started_at, monthly_used, reserved_tokens) "
        "VALUES (:u, 15, :s, :m, 0)",
        u=uid, s=period_start, m=monthly // 2,
    )
    me = await _me(uid)
    [w] = me["limits"]
    assert w["used_pct"] == round((monthly // 2) / monthly * 100, 1) and w["resets_at"] == refills
    assert w["resets"] is True and refills.endswith("-15T00:00:00Z")
    assert me["blocked"] is None and me["usage_pct"] == w["used_pct"]
    assert me["period_start"] == start and me["reset_at"] == refills

    await db("UPDATE core.usage_accounts SET monthly_used = :m WHERE user_id = :u", u=uid, m=monthly)
    me = await _me(uid)
    assert me["blocked"] == {"key": "monthly", "resets_at": refills, "resets": True}


async def test_a_spent_free_credit_shows_no_reset_at_all():
    """The Free trial credit is the one window with nothing to count down to:
    ``resets`` is False and ``resets_at`` stays null even once it is full, so
    the client says "spent, upgrade" instead of "resets in 0s"."""
    uid = await make_user(email("usage"), plan="free")
    credit = limits.window_limit("free", "lifetime")
    await db(
        "INSERT INTO core.usage_accounts (user_id, lifetime_started_at, lifetime_used, reserved_tokens) "
        "VALUES (:u, '2099-01-01T00:00:00Z', :c, 0)",
        u=uid, c=credit,
    )
    me = await _me(uid)
    [w] = me["limits"]
    assert (w["key"], w["label"], w["used_pct"], w["active"]) == ("lifetime", "Trial credit", 100.0, True)
    assert w["resets"] is False and w["resets_at"] is None
    assert me["blocked"] == {"key": "lifetime", "resets_at": None, "resets": False}
    assert me["resets"] is False and me["reset_at"] is None


async def test_the_wallet_shows_baht_once_bought():
    uid = await make_user(email("usage"))
    async with get_sessionmaker()() as s:
        await s.execute(text("SET search_path TO core, public"))
        await wallet.credit(s, uid, 29_950, source="mock")
        await s.commit()
    me = await _me(uid)
    assert me["wallet"]["balance_satang"] == 29_950 and me["wallet"]["next_expiry"].endswith("Z")


async def test_admins_are_unlimited_with_no_windows():
    me = await _me(await make_user(email("usage"), admin=True))
    assert me["unlimited"] is True and me["limits"] == [] and me["usage_pct"] is None
    assert me["concurrency"]["max"] == limits.UNLIMITED_CONCURRENCY and me["storage"]["quota_bytes"] == 0


async def test_the_minutes_endpoint_is_gone():
    uid = await make_user(email("usage"))
    async with client() as c:
        r = await c.get("/usage/stt", headers=bearer(await user_token(uid)))
    assert r.status_code in (404, 405)


async def test_the_estimate_counts_what_is_already_used_and_the_wallet():
    uid = await make_user(email("usage"), plan="free")
    body = {"mode": "dub_first", "engine": "lite", "precision": "standard", "clips": [{"duration_sec": 30}]}
    async with client() as c:
        h = bearer(await user_token(uid))
        empty = (await c.post("/usage/estimate", json=body, headers=h)).json()
        await db(
            "INSERT INTO core.usage_accounts (user_id, lifetime_started_at, lifetime_used) "
            "VALUES (:u, now(), :m)", u=uid, m=limits.window_limit("free", "lifetime") - 1_000,
        )
        full = (await c.post("/usage/estimate", json=body, headers=h)).json()
        async with get_sessionmaker()() as s:
            await s.execute(text("SET search_path TO core, public"))
            await wallet.credit(s, uid, 100_000, source="mock")
            await s.commit()
        paid = (await c.post("/usage/estimate", json=body, headers=h)).json()
    assert empty["fits"] == "plan" and empty["resets_at"] is None
    # A spent trial credit has no reset time to offer — only "upgrade".
    assert full["fits"] == "none" and full["binding"] == "lifetime"
    assert full["resets_at"] is None and full["resets"] is False
    assert full["pct"] == empty["pct"] and full["wallet_satang"] > 0
    assert paid["fits"] == "wallet" and paid["wallet_satang"] == full["wallet_satang"]
    assert not any("token" in k for k in _keys(paid))
