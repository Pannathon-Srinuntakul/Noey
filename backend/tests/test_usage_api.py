"""What a user sees of their limits: GET /usage/me and POST /usage/estimate.

Percentages, reset times (UTC ISO) and baht — never a token count anywhere
in the body (docs/token-billing-plan.md §1).
"""

from sqlalchemy import text

from packages.billing import limits, wallet
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


async def test_a_fresh_pro_account_sees_two_empty_windows():
    uid = await make_user(email("usage"), plan="pro")
    me = await _me(uid)
    assert me["plan"] == "pro" and me["unlimited"] is False
    assert [(w["key"], w["label"], w["used_pct"], w["active"], w["resets_at"]) for w in me["limits"]] == [
        ("weekly", "Weekly limit", 0.0, False, None),
        ("five_hour", "5-hour limit", 0.0, False, None),
    ]
    assert me["blocked"] is None and me["wallet"] is None and me["pending_plan"] is None
    assert me["concurrency"] == {"max": 2, "running": 0, "queued": 0}
    assert me["storage"]["quota_bytes"] == 10 * 1024**3
    assert [t["task"] for t in me["by_task"]] == ["cut", "effects", "style", "other"]
    # Compat fields the marketing site's account pages read.
    assert me["usage_pct"] == 0.0 and me["period_start"].endswith("Z") and me["reset_at"] is None
    assert not any("token" in k for k in _keys(me)), sorted(_keys(me))


async def test_used_windows_show_percent_reset_time_and_block_when_full():
    uid = await make_user(email("usage"), plan="lite")
    weekly = limits.window_limit("lite", "weekly")
    await db(
        "INSERT INTO core.usage_accounts (user_id, weekly_started_at, weekly_used, reserved_tokens) "
        "VALUES (:u, '2099-01-01T00:00:00Z', :w, 0)",
        u=uid, w=weekly // 2,
    )
    me = await _me(uid)
    [w] = me["limits"]
    assert w["used_pct"] == round((weekly // 2) / weekly * 100, 1) and w["resets_at"] == "2099-01-08T00:00:00Z"
    assert me["blocked"] is None and me["usage_pct"] == w["used_pct"]
    assert me["period_start"] == "2099-01-01T00:00:00Z" and me["reset_at"] == "2099-01-08T00:00:00Z"

    await db("UPDATE core.usage_accounts SET weekly_used = :w WHERE user_id = :u", u=uid, w=weekly)
    me = await _me(uid)
    assert me["blocked"] == {"key": "weekly", "resets_at": "2099-01-08T00:00:00Z"}


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
            "INSERT INTO core.usage_accounts (user_id, monthly_started_at, monthly_used) "
            "VALUES (:u, now(), :m)", u=uid, m=limits.window_limit("free", "monthly") - 1_000,
        )
        full = (await c.post("/usage/estimate", json=body, headers=h)).json()
        async with get_sessionmaker()() as s:
            await s.execute(text("SET search_path TO core, public"))
            await wallet.credit(s, uid, 100_000, source="mock")
            await s.commit()
        paid = (await c.post("/usage/estimate", json=body, headers=h)).json()
    assert empty["fits"] == "plan" and empty["resets_at"] is None
    assert full["fits"] == "none" and full["binding"] == "monthly" and full["resets_at"].endswith("Z")
    assert full["pct"] == empty["pct"] and full["wallet_satang"] > 0
    assert paid["fits"] == "wallet" and paid["wallet_satang"] == full["wallet_satang"]
    assert not any("token" in k for k in _keys(paid))
