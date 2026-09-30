"""Site -> editor sign-in handoff (routers/auth_handoff.py, packages/auth/handoff.py).

A code is minted by a signed-in caller for THEIR OWN account, lives 60 s, is
spent exactly once, and redeems into the same pair /auth/login issues. The
store is in memory (tests/conftest.py); the Redis store is exercised against
the local Redis when one answers.
"""

import jwt
import pytest

from packages.auth import handoff, refresh_store
from packages.auth.handoff import DownHandoffStore, MemoryHandoffStore, RedisHandoffStore
from services.api import ratelimit
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    PASSWORD,
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
)


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


async def _login(c, address: str) -> dict:
    r = await c.post("/auth/login", json={"email": address, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()


async def _mint(c, access: str, body: dict | None = None) -> dict:
    r = await c.post("/auth/handoff", headers=bearer(access), json=body or {"target": "editor"})
    assert r.status_code == 200, r.text
    return r.json()


async def _redeem(c, code: str, **extra):
    return await c.post("/auth/handoff/redeem", json={"code": code, "target": "editor"}, **extra)


# ── happy path ────────────────────────────────────────────────────────────────

async def test_handoff_redeems_into_a_normal_session_for_the_minting_user():
    address = email("ho")
    uid = await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        minted = await _mint(c, pair["access_token"])
        assert minted["expires_in"] == 60
        assert len(minted["code"]) >= 40
        r = await _redeem(c, minted["code"])
        assert r.status_code == 200, r.text
        out = r.json()
        # Exactly /auth/login's shape and claims — same token issuance.
        assert set(out) == {"access_token", "refresh_token", "token_type"}
        assert out["token_type"] == "bearer"
        access, refresh = _claims(out["access_token"]), _claims(out["refresh_token"])
        assert access["sub"] == str(uid) and access["type"] == "access"
        assert refresh["sub"] == str(uid) and refresh["type"] == "refresh" and refresh["jti"]
        assert access["tv"] == _claims(pair["access_token"])["tv"]
        # The new session is a real one: /me works, and its refresh token is
        # registered in the refresh store (it rotates).
        me = await c.get("/auth/me", headers=bearer(out["access_token"]))
        assert me.status_code == 200 and me.json()["user_id"] == uid
        rotated = await c.post("/auth/refresh", headers=bearer(out["refresh_token"]))
        assert rotated.status_code == 200, rotated.text


async def test_the_code_is_stored_hashed_with_a_60_second_ttl(monkeypatch):
    seen: list[tuple[str, str, int]] = []

    class Recording(MemoryHandoffStore):
        async def put(self, key: str, value: str, ttl_sec: int) -> None:
            seen.append((key, value, ttl_sec))
            await super().put(key, value, ttl_sec)

    monkeypatch.setattr(handoff, "_store", Recording())
    address = email("ho-hash")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        code = (await _mint(c, pair["access_token"]))["code"]
    assert len(seen) == 1
    key, value, ttl = seen[0]
    assert ttl == 60
    assert code not in key and code not in value
    assert key == handoff.key_for("editor", code)


# ── refusals ──────────────────────────────────────────────────────────────────

async def test_a_code_works_once():
    address = email("ho-once")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        code = (await _mint(c, pair["access_token"]))["code"]
        first = await _redeem(c, code)
        second = await _redeem(c, code)
    assert first.status_code == 200
    assert second.status_code == 401


async def test_an_expired_code_is_refused(monkeypatch):
    store = MemoryHandoffStore()
    monkeypatch.setattr(handoff, "_store", store)
    address = email("ho-exp")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        code = (await _mint(c, pair["access_token"]))["code"]
        # Past its TTL: the store (Redis EX in production) no longer has it.
        for key, (_, value) in list(store.records.items()):
            store.records[key] = (0.0, value)
        r = await _redeem(c, code)
    assert r.status_code == 401


async def test_unknown_and_malformed_codes_are_refused():
    async with client() as c:
        unknown = await _redeem(c, "x" * 43)
        too_long = await _redeem(c, "x" * 500)
        other_target = await c.post("/auth/handoff/redeem", json={"code": "x" * 43, "target": "admin"})
    assert unknown.status_code == 401
    assert too_long.status_code == 422
    assert other_target.status_code == 422


async def test_a_code_is_bound_to_its_target():
    code = await handoff.mint(1, 0, "editor")
    # The key includes the target: presented as any other target it is unknown.
    assert await handoff.redeem(code, "site") is None
    assert (await handoff.redeem(code, "editor")) is not None


async def test_minting_needs_a_session():
    async with client() as c:
        r = await c.post("/auth/handoff", json={"target": "editor"})
    assert r.status_code == 401


@pytest.mark.parametrize("change", ["deactivated", "deleted", "password_changed"])
async def test_account_changes_after_minting_void_the_code(change):
    address = email(f"ho-{change[:4]}")
    uid = await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        code = (await _mint(c, pair["access_token"]))["code"]
        if change == "deactivated":
            await db("UPDATE core.users SET is_active = false WHERE id = :u", u=uid)
        elif change == "deleted":
            # deleted_at alone must be enough (belt and braces with is_active).
            await db("UPDATE core.users SET deleted_at = now() WHERE id = :u", u=uid)
        else:
            await db("UPDATE core.users SET token_version = token_version + 1 WHERE id = :u", u=uid)
        r = await _redeem(c, code)
    assert r.status_code == 401


async def test_a_code_always_signs_in_its_minter_never_the_presenter():
    a_addr, b_addr = email("ho-a"), email("ho-b")
    a_uid = await make_user(a_addr)
    b_uid = await make_user(b_addr)
    async with client() as c:
        a_pair = await _login(c, a_addr)
        b_pair = await _login(c, b_addr)
        # B cannot mint for A: the body has no user field, and one smuggled in is ignored.
        b_code = (await _mint(c, b_pair["access_token"], {"target": "editor", "user_id": a_uid}))["code"]
        a_code = (await _mint(c, a_pair["access_token"]))["code"]
        # B presenting A's code while holding B's own bearer gets A's session
        # (the minter's) — the header is ignored, nothing merges.
        via_b = await _redeem(c, a_code, headers=bearer(b_pair["access_token"]))
        b_self = await _redeem(c, b_code)
    assert via_b.status_code == 200 and _claims(via_b.json()["access_token"])["sub"] == str(a_uid)
    assert b_self.status_code == 200 and _claims(b_self.json()["access_token"])["sub"] == str(b_uid)


# ── rate limits + store outage ────────────────────────────────────────────────

async def test_redeem_is_rate_limited_per_ip():
    async with client() as c:
        codes = [
            (await _redeem(c, f"guess-{i}")).status_code
            for i in range(ratelimit.HANDOFF_REDEEM_IP.max_hits + 1)
        ]
    assert set(codes[:-1]) == {401}
    assert codes[-1] == 429


async def test_mint_is_rate_limited_per_account():
    address = email("ho-rl")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        codes = [
            (await c.post("/auth/handoff", headers=bearer(pair["access_token"]), json={})).status_code
            for _ in range(ratelimit.HANDOFF_MINT_ACCOUNT.max_hits + 1)
        ]
    assert set(codes[:-1]) == {200}
    assert codes[-1] == 429


async def test_a_store_outage_refuses_instead_of_assuming(monkeypatch):
    address = email("ho-down")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        monkeypatch.setattr(handoff, "_store", DownHandoffStore())
        mint = await c.post("/auth/handoff", headers=bearer(pair["access_token"]), json={})
        redeem = await _redeem(c, "x" * 43)
    assert mint.status_code == 503
    assert redeem.status_code == 503


async def test_a_refresh_store_outage_on_redeem_is_a_503_and_the_code_is_gone(monkeypatch):
    address = email("ho-rs")
    await make_user(address)
    async with client() as c:
        pair = await _login(c, address)
        code = (await _mint(c, pair["access_token"]))["code"]
        monkeypatch.setattr(refresh_store, "_store", refresh_store.DownRefreshStore())
        r = await _redeem(c, code)
        monkeypatch.setattr(refresh_store, "_store", refresh_store.MemoryRefreshStore())
        again = await _redeem(c, code)
    assert r.status_code == 503
    # Spent even though issuing failed: single use means single use.
    assert again.status_code == 401


# ── the Redis store itself ────────────────────────────────────────────────────

async def test_redis_store_is_getdel_single_use():
    import redis.asyncio as aioredis
    from redis.exceptions import RedisError

    from packages.core.settings import get_settings

    client_ = aioredis.from_url(get_settings().redis_url, socket_timeout=1.0, socket_connect_timeout=1.0)
    try:
        await client_.ping()
    except (RedisError, OSError):
        await client_.aclose()
        pytest.skip("no local Redis")
    store = RedisHandoffStore(client=client_)
    key = handoff.key_for("editor", handoff.new_code())
    try:
        await store.put(key, '{"uid": 1, "tv": 0}', 60)
        assert 0 < await client_.ttl(key) <= 60
        assert await store.take(key) == '{"uid": 1, "tv": 0}'
        assert await store.take(key) is None
    finally:
        await client_.delete(key)
        await client_.aclose()
