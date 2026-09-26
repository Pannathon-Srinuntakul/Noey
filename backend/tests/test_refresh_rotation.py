"""Refresh-token rotation, logout, the deploy grace for pre-rotation tokens,
the fail-closed store, JWT hygiene (aud + required claims) and the login
hashing path (dummy hash, off-loop bcrypt, >72-byte passwords).

The store is swapped for an in-memory one per test (tests/conftest.py does
not know about it); the Redis store itself is exercised against the local
Redis from REDIS_URL when one answers, and skipped otherwise.
"""

import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from packages.auth import refresh_store, tokens
from packages.auth.hashing import dummy_hash
from packages.auth.refresh_store import (
    Consume,
    DownRefreshStore,
    MemoryRefreshStore,
    RedisRefreshStore,
    RefreshStoreUnavailable,
)
from packages.core.settings import get_settings
from services.api.routers import auth as auth_router
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    PASSWORD,
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)


@pytest.fixture(autouse=True)
def _memory_refresh_store(monkeypatch):
    store = MemoryRefreshStore()
    monkeypatch.setattr(refresh_store, "_store", store)
    return store


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


def _signed(payload: dict, *, minutes: int = 5) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    return jwt.encode(
        {"iat": now, "exp": now + timedelta(minutes=minutes), **payload},
        s.jwt_secret,
        algorithm=s.jwt_algorithm,
    )


async def _login(c, address: str) -> dict:
    r = await c.post("/auth/login", json={"email": address, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()


async def _refresh(c, token: str) -> tuple[int, dict | None]:
    r = await c.post("/auth/refresh", headers=bearer(token))
    return r.status_code, (r.json() if r.status_code == 200 else None)


# ── rotation ──────────────────────────────────────────────────────────────────

async def test_refresh_rotates_and_the_presented_token_is_spent():
    address = email("rot")
    uid = await make_user(address)
    async with client() as c:
        first = await _login(c, address)
        assert _claims(first["refresh_token"])["jti"]
        code, second = await _refresh(c, first["refresh_token"])
        assert code == 200 and second is not None
        assert set(second) == {"access_token", "refresh_token", "token_type"}
        assert second["token_type"] == "bearer"
        assert _claims(second["refresh_token"])["jti"] != _claims(first["refresh_token"])["jti"]
        # The new pair works and rotates onward; the presented token is gone
        # (and replaying it is the theft path — next test).
        me = await c.get("/auth/me", headers=bearer(second["access_token"]))
        third, _ = await _refresh(c, second["refresh_token"])
        again, _ = await _refresh(c, first["refresh_token"])
    assert me.status_code == 200 and me.json()["user_id"] == uid
    assert third == 200
    assert again == 401


async def test_reuse_of_a_spent_token_revokes_the_whole_family():
    """Replaying a rotated-away token is the theft signal: every session of the
    user — including the pair the replay's honest sibling just received — is
    revoked through `tv`, and a fresh login is the only way back in."""
    address = email("theft")
    uid = await make_user(address)
    async with client() as c:
        stolen = (await _login(c, address))["refresh_token"]
        code, honest = await _refresh(c, stolen)
        assert code == 200 and honest is not None
        replay, _ = await _refresh(c, stolen)
        tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=uid))[0][0]
        honest_access = await c.get("/auth/me", headers=bearer(honest["access_token"]))
        honest_refresh, _ = await _refresh(c, honest["refresh_token"])
        back_in = await c.post("/auth/login", json={"email": address, "password": PASSWORD})
    assert replay == 401
    assert tv == 1
    assert honest_access.status_code == 401 and honest_refresh == 401
    assert back_in.status_code == 200


async def test_unknown_jti_is_refused_without_punishing_the_user():
    """A token the store never saw (flushed, expired, forged with the secret)
    is a plain 401: only a PROVEN reuse bumps `tv`."""
    address = email("unknown")
    uid = await make_user(address)
    row = (await db(
        "SELECT t.id FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id WHERE m.user_id = :u",
        u=uid,
    ))[0]
    unregistered = tokens.encode_refresh(uid, int(row[0]), 0, jti=tokens.new_jti())
    async with client() as c:
        code, _ = await _refresh(c, unregistered)
        tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=uid))[0][0]
        live = await _login(c, address)
        still_fine, _ = await _refresh(c, live["refresh_token"])
    assert code == 401 and tv == 0 and still_fine == 200


async def test_malformed_jti_is_refused():
    address = email("badjti")
    uid = await make_user(address)
    async with client() as c:
        claims = _claims((await _login(c, address))["refresh_token"])
        weird = _signed({**{k: claims[k] for k in ("sub", "tid", "tv", "type", "aud")}, "jti": 12345})
        code, _ = await _refresh(c, weird)
        tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=uid))[0][0]
    assert code == 401 and tv == 0  # refused, not treated as theft


# ── deploy grace: tokens without jti ──────────────────────────────────────────

async def test_pre_rotation_refresh_token_is_accepted_once():
    """A refresh token issued before rotation shipped has no `jti`. The first
    use rotates it (nobody is signed out by the deploy); the second is a plain
    401 — not the theft path, `tv` is untouched."""
    address = email("legacy")
    uid = await make_user(address)
    async with client() as c:
        claims = _claims((await _login(c, address))["refresh_token"])
        legacy = _signed({"sub": claims["sub"], "tid": claims["tid"], "tv": 0, "type": "refresh"})
        assert "jti" not in _claims(legacy) and "aud" not in _claims(legacy)
        first, rotated = await _refresh(c, legacy)
        second, _ = await _refresh(c, legacy)
        tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=uid))[0][0]
        assert rotated is not None
        onward, _ = await _refresh(c, rotated["refresh_token"])
    assert first == 200 and "jti" in _claims(rotated["refresh_token"])
    assert second == 401
    assert tv == 0
    assert onward == 200


async def test_logout_spends_a_pre_rotation_token_too():
    address = email("legacy-out")
    uid = await make_user(address)
    async with client() as c:
        live = await _login(c, address)
        claims = _claims(live["refresh_token"])
        legacy = _signed({"sub": claims["sub"], "tid": claims["tid"], "tv": 0, "type": "refresh"})
        out = await c.post(
            "/auth/logout", json={"refresh_token": legacy}, headers=bearer(live["access_token"])
        )
        after, _ = await _refresh(c, legacy)
    assert out.status_code == 204 and after == 401
    assert uid


# ── logout ────────────────────────────────────────────────────────────────────

async def test_logout_with_a_refresh_token_drops_only_that_session():
    address = email("logout-one")
    await make_user(address)
    async with client() as c:
        laptop = await _login(c, address)
        phone = await _login(c, address)
        out = await c.post(
            "/auth/logout",
            json={"refresh_token": laptop["refresh_token"]},
            headers=bearer(laptop["access_token"]),
        )
        laptop_refresh, _ = await _refresh(c, laptop["refresh_token"])
        phone_refresh, _ = await _refresh(c, phone["refresh_token"])
        # The access token is not revoked by logout: it dies on its own exp.
        laptop_access = await c.get("/auth/me", headers=bearer(laptop["access_token"]))
    assert out.status_code == 204 and out.content == b""
    assert laptop_refresh == 401
    assert phone_refresh == 200
    assert laptop_access.status_code == 200


async def test_logout_without_a_body_drops_every_session():
    address = email("logout-all")
    uid = await make_user(address)
    async with client() as c:
        laptop = await _login(c, address)
        phone = await _login(c, address)
        out = await c.post("/auth/logout", headers=bearer(laptop["access_token"]))
        codes = [
            (await _refresh(c, laptop["refresh_token"]))[0],
            (await _refresh(c, phone["refresh_token"]))[0],
        ]
        tv = (await db("SELECT token_version FROM core.users WHERE id = :u", u=uid))[0][0]
    assert out.status_code == 204
    assert codes == [401, 401]
    assert tv == 0  # logout is the gentle path; `tv` stays for password changes


async def test_logout_ignores_expiry_but_not_ownership():
    address, other = email("logout-me"), email("logout-other")
    await make_user(address)
    await make_user(other)
    async with client() as c:
        mine = await _login(c, address)
        theirs = await _login(c, other)
        claims = _claims(mine["refresh_token"])
        expired = _signed({**{k: claims[k] for k in ("sub", "tid", "tv", "type", "aud", "jti")}}, minutes=-5)
        gone = await c.post(
            "/auth/logout", json={"refresh_token": expired}, headers=bearer(mine["access_token"])
        )
        foreign = await c.post(
            "/auth/logout", json={"refresh_token": theirs["refresh_token"]}, headers=bearer(mine["access_token"])
        )
        junk = await c.post(
            "/auth/logout", json={"refresh_token": "not.a.jwt"}, headers=bearer(mine["access_token"])
        )
        access_as_refresh = await c.post(
            "/auth/logout", json={"refresh_token": mine["access_token"]}, headers=bearer(mine["access_token"])
        )
        anonymous = await c.post("/auth/logout")
        # The expired token shared the live one's jti: that session is gone.
        mine_after, _ = await _refresh(c, mine["refresh_token"])
        theirs_after, _ = await _refresh(c, theirs["refresh_token"])
    assert gone.status_code == 204
    assert foreign.status_code == 400 and junk.status_code == 400 and access_as_refresh.status_code == 400
    assert anonymous.status_code == 401
    assert mine_after == 401 and theirs_after == 200


# ── the store fails closed ────────────────────────────────────────────────────

async def test_refresh_is_refused_when_the_store_is_unreachable(monkeypatch):
    address = email("down")
    await make_user(address)
    async with client() as c:
        live = await _login(c, address)
        monkeypatch.setattr(refresh_store, "_store", DownRefreshStore())
        refresh = await c.post("/auth/refresh", headers=bearer(live["refresh_token"]))
        login = await c.post("/auth/login", json={"email": address, "password": PASSWORD})
        logout = await c.post("/auth/logout", headers=bearer(live["access_token"]))
        # Access tokens never touch the store: the app keeps working.
        me = await c.get("/auth/me", headers=bearer(live["access_token"]))
    assert refresh.status_code == 401
    assert login.status_code == 503
    assert logout.status_code == 503
    assert me.status_code == 200


async def test_memory_store_semantics():
    store = MemoryRefreshStore()
    await store.issue(7, "a", 60)
    await store.issue(7, "b", 60)
    await store.issue(8, "c", 60)
    assert await store.consume(7, "a", 60) is Consume.SPENT
    assert await store.consume(7, "a", 60) is Consume.REUSED
    assert await store.consume(7, "zzz", 60) is Consume.UNKNOWN
    await store.revoke(7, "b")
    assert await store.consume(7, "b", 60) is Consume.UNKNOWN  # dropped, not reused
    assert await store.revoke_all(8) == 1
    assert await store.consume(8, "c", 60) is Consume.UNKNOWN
    assert await store.consume_legacy(7, "tok", 60) is True
    assert await store.consume_legacy(7, "tok", 60) is False


async def _redis_or_skip():
    import redis.asyncio as aioredis

    r = aioredis.from_url(get_settings().redis_url, socket_timeout=0.5, socket_connect_timeout=0.5)
    try:
        await r.ping()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"no Redis at REDIS_URL: {type(exc).__name__}")
    return r


async def test_redis_store_against_a_real_redis():
    """The Lua consume script and the per-user set, on the local Redis."""
    r = await _redis_or_skip()
    uid = 900_000_000 + int(uuid.uuid4().int % 1_000_000)  # nobody's id
    store = RedisRefreshStore(client=r)
    try:
        await store.issue(uid, "a", 60)
        await store.issue(uid, "b", 60)
        assert await store.consume(uid, "a", 60) is Consume.SPENT
        assert await store.consume(uid, "a", 60) is Consume.REUSED
        assert await store.consume(uid, "nope", 60) is Consume.UNKNOWN
        assert 0 < await r.ttl(refresh_store.used_key(uid, "a")) <= 60
        assert await r.smembers(refresh_store.user_set_key(uid)) == {b"b"}
        await store.issue(uid, "c", 60)
        await store.revoke(uid, "c")
        assert await store.consume(uid, "c", 60) is Consume.UNKNOWN
        assert await store.consume_legacy(uid, "legacy-token", 60) is True
        assert await store.consume_legacy(uid, "legacy-token", 60) is False
        assert await store.revoke_all(uid) == 1  # only "b" was still live
        assert await store.consume(uid, "b", 60) is Consume.UNKNOWN
        assert await r.exists(refresh_store.user_set_key(uid)) == 0
    finally:
        keys = [k async for k in r.scan_iter(match=f"{refresh_store.PREFIX}*{uid}*")]
        if keys:
            await r.delete(*keys)
        await r.aclose()


async def test_redis_store_raises_unavailable_on_connection_errors():
    import redis.asyncio as aioredis

    dead = aioredis.from_url("redis://127.0.0.1:1/0", socket_timeout=0.2, socket_connect_timeout=0.2)
    store = RedisRefreshStore(client=dead)
    for call in (
        store.issue(1, "x", 60),
        store.consume(1, "x", 60),
        store.consume_legacy(1, "t", 60),
        store.revoke(1, "x"),
        store.revoke_all(1),
    ):
        with pytest.raises(RefreshStoreUnavailable):
            await call
    await dead.aclose()


# ── JWT hygiene ───────────────────────────────────────────────────────────────

def test_user_tokens_carry_the_app_audience():
    assert _claims(tokens.encode_access(1, 2, "slug", 0))["aud"] == "noey-app"
    assert _claims(tokens.encode_refresh(1, 2, 0, jti="j"))["aud"] == "noey-app"
    assert "jti" not in _claims(tokens.encode_refresh(1, 2, 0))  # legacy shape, scripts only


def test_decode_accepts_no_aud_during_the_grace_but_never_another_audience():
    base = {"sub": "1", "tid": 2, "type": "access"}
    assert tokens.decode(_signed(base))["sub"] == "1"  # pre-aud token: grace
    assert tokens.decode(_signed({**base, "aud": "noey-app"}))["aud"] == "noey-app"
    with pytest.raises(jwt.InvalidAudienceError):
        tokens.decode(_signed({**base, "aud": "noey-admin"}))
    with pytest.raises(jwt.InvalidAudienceError):
        tokens.decode(_signed({**base, "aud": ["noey-admin"]}))


@pytest.mark.parametrize("missing", ["exp", "iat", "sub", "tid", "type"])
def test_decode_requires_the_claims_the_routers_index(missing):
    full = {"sub": "1", "tid": 2, "type": "access", "aud": "noey-app"}
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"iat": now, "exp": now + timedelta(minutes=5), **full}
    del payload[missing]
    token = jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)
    with pytest.raises(jwt.MissingRequiredClaimError):
        tokens.decode(token)


async def test_an_admin_token_is_not_a_user_token():
    """Same secret, different audience: the admin dashboard's tokens must not
    open the editor (and the reverse is the admin suite's job)."""
    address = email("aud")
    uid = await make_user(address, admin=True)
    from packages.admin.auth import ADMIN_AUDIENCE

    forged = _signed({"sub": str(uid), "tid": 1, "type": "access", "tslug": "x", "aud": ADMIN_AUDIENCE})
    async with client() as c:
        r = await c.get("/auth/me", headers=bearer(forged))
    assert r.status_code == 401


def test_decode_without_exp_check_is_for_logout_only():
    expired = _signed({"sub": "1", "tid": 2, "type": "refresh"}, minutes=-1)
    with pytest.raises(jwt.ExpiredSignatureError):
        tokens.decode(expired)
    assert tokens.decode(expired, verify_exp=False)["type"] == "refresh"


# ── login hashing ─────────────────────────────────────────────────────────────

def test_dummy_hash_is_a_stable_bcrypt_hash_that_matches_nothing():
    from packages.auth.hashing import verify_password

    first, second = dummy_hash(), dummy_hash()
    assert first == second and first.startswith("$2")
    assert verify_password("", first) is False
    assert verify_password("password", first) is False


async def test_login_hashes_off_the_loop_and_against_a_dummy_for_unknown_users(monkeypatch):
    """Both branches go through `_password_matches` in a worker thread, and the
    unknown-address branch compares against the dummy hash (no fast 401)."""
    import threading

    seen: list[tuple[str, str]] = []
    main = threading.get_ident()
    real = auth_router._password_matches

    def spy(plain: str, hashed: str) -> bool:
        seen.append((hashed, "thread" if threading.get_ident() != main else "loop"))
        return real(plain, hashed)

    monkeypatch.setattr(auth_router, "_password_matches", spy)
    address = email("hash")
    uid = await make_user(address)
    stored = (await db("SELECT password_hash FROM core.users WHERE id = :u", u=uid))[0][0]
    async with client() as c:
        unknown = await c.post("/auth/login", json={"email": email("nobody"), "password": "x"})
        known = await c.post("/auth/login", json={"email": address, "password": PASSWORD})
    assert unknown.status_code == 401 and known.status_code == 200
    assert seen == [(dummy_hash(), "thread"), (stored, "thread")]


async def test_login_with_a_73_byte_password_is_401_not_500():
    address = email("long")
    await make_user(address)
    async with client() as c:
        r = await c.post("/auth/login", json={"email": address, "password": "x" * 73})
        unknown = await c.post("/auth/login", json={"email": email("nobody"), "password": "y" * 200})
    assert r.status_code == 401 and unknown.status_code == 401


async def test_login_is_limited_per_email_across_ips(monkeypatch):
    """The per-email rule catches one account being guessed from many IPs,
    which the `email|ip` pair alone never adds up."""
    from services.api import ratelimit

    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    get_settings.cache_clear()
    monkeypatch.setattr(ratelimit, "LOGIN_EMAIL", ratelimit.Limit("login:email", 3, 900))
    target = email("spread")
    async with client() as c:
        codes = [
            (
                await c.post(
                    "/auth/login",
                    json={"email": target, "password": "x"},
                    headers={"X-Forwarded-For": f"198.51.100.{i}"},
                )
            ).status_code
            for i in range(1, 5)
        ]
    assert codes == [401, 401, 401, 429]
