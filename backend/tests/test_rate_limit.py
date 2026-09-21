"""Rate limits: the Redis store (against a fake Redis), fail-open, 429 shape,
client-IP resolution behind proxies, and the limits on real endpoints."""

import uuid
from typing import Any, Self

import pytest
import redis.exceptions
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from packages.core.settings import get_settings
from services.api import ratelimit
from services.api.main import app
from services.api.ratelimit import Limit, MemoryCounterStore, RateLimiter, RedisCounterStore


class FakePipeline:
    def __init__(self, redis_: "FakeRedis") -> None:
        self.redis = redis_
        self.ops: list[tuple] = []

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def incr(self, key: str) -> None:
        self.ops.append(("incr", key))

    def expire(self, key: str, ttl: int) -> None:
        self.ops.append(("expire", key, ttl))

    async def execute(self) -> list:
        self.redis.executes += 1
        if self.redis.down:
            raise redis.exceptions.ConnectionError("Connection refused")
        out: list = []
        for op in self.ops:
            if op[0] == "incr":
                self.redis.data[op[1]] = self.redis.data.get(op[1], 0) + 1
                out.append(self.redis.data[op[1]])
            else:
                self.redis.ttl[op[1]] = op[2]
                out.append(True)
        return out


class FakeRedis:
    def __init__(self, *, down: bool = False) -> None:
        self.data: dict[str, int] = {}
        self.ttl: dict[str, int] = {}
        self.down = down
        self.executes = 0

    def pipeline(self, transaction: bool = True) -> FakePipeline:
        assert transaction is True
        return FakePipeline(self)


# ── the store ─────────────────────────────────────────────────────────────────

async def test_redis_store_counts_a_fixed_window_and_never_stores_the_identity():
    fake = FakeRedis()
    limiter = RateLimiter(RedisCounterStore("redis://unused", client=fake))
    rule = Limit("t:email", 3, 60)
    for _ in range(3):
        await limiter.check([(rule, "Beam@Example.com")])
    with pytest.raises(HTTPException) as exc:
        await limiter.check([(rule, "beam@example.com ")])  # same identity, normalised
    assert exc.value.status_code == 429
    (key,) = fake.data
    assert key.startswith("noey:rl:t:email:")
    assert "beam" not in key and "example" not in key
    assert fake.data[key] == 4 and fake.ttl[key] == 60


class _RecordingLog:
    def __init__(self) -> None:
        self.warnings: list[tuple[str, dict[str, Any]]] = []

    def warning(self, event: str, **kw: Any) -> None:
        self.warnings.append((event, kw))

    def info(self, event: str, **kw: Any) -> None:
        pass


async def test_redis_down_fails_open_and_backs_off(monkeypatch):
    recorded = _RecordingLog()
    monkeypatch.setattr(ratelimit, "log", recorded)
    fake = FakeRedis(down=True)
    limiter = RateLimiter(RedisCounterStore("redis://unused", client=fake))
    rule = Limit("t", 1, 60)
    for _ in range(5):
        await limiter.check([(rule, "someone")])  # never raises
    assert fake.executes == 1  # the breaker skips Redis after the first failure
    assert recorded.warnings == [
        ("rate_limit_store_unavailable", {"error": "ConnectionError", "fail_open": True})
    ]


async def test_429_is_thai_with_retry_after():
    limiter = RateLimiter(MemoryCounterStore())
    rule = Limit("t", 1, 3600)
    await limiter.check([(rule, "x")])
    with pytest.raises(HTTPException) as exc:
        await limiter.check([(rule, "x")])
    assert exc.value.status_code == 429
    assert "นาที" in str(exc.value.detail)
    headers = exc.value.headers or {}
    assert 0 < int(headers["Retry-After"]) <= 3600


async def test_rules_are_checked_in_order_and_empty_identities_skipped():
    limiter = RateLimiter(MemoryCounterStore())
    first, second = Limit("a", 1, 60), Limit("b", 5, 60)
    await limiter.check([(first, "id"), (second, None)])
    with pytest.raises(HTTPException):
        await limiter.check([(first, "id"), (second, "ip")])
    assert not any(":b:" in key for key in limiter.store.counts)  # type: ignore[attr-defined]


# ── client IP ─────────────────────────────────────────────────────────────────

def _request(xff: str | None, peer: str = "10.0.0.1") -> Request:
    headers = [(b"x-forwarded-for", xff.encode())] if xff is not None else []
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers, "client": (peer, 5555)})


@pytest.mark.parametrize(
    ("hops", "xff", "expected"),
    [
        (0, "203.0.113.9", "10.0.0.1"),  # default: the socket peer, XFF ignored
        (1, "203.0.113.9", "203.0.113.9"),
        (1, "6.6.6.6, 203.0.113.9", "203.0.113.9"),  # a forged left entry is ignored
        (2, "198.51.100.7, 100.64.0.2", "198.51.100.7"),
        (2, "198.51.100.7", "198.51.100.7"),  # shorter chain: leftmost
        (1, None, "10.0.0.1"),
        (1, " , ", "10.0.0.1"),
    ],
)
def test_client_ip(monkeypatch, hops, xff, expected):
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", str(hops))
    get_settings.cache_clear()
    assert ratelimit.client_ip(_request(xff)) == expected


# ── on real endpoints ─────────────────────────────────────────────────────────

def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _nobody() -> str:
    return f"nobody-{uuid.uuid4().hex[:8]}@ratelimit.example.com"


async def test_login_is_limited_per_email_and_ip():
    target, other = _nobody(), _nobody()
    async with _client() as c:
        codes = [
            (await c.post("/auth/login", json={"email": target, "password": "x"})).status_code
            for _ in range(11)
        ]
        elsewhere = await c.post("/auth/login", json={"email": other, "password": "x"})
    assert codes == [401] * 10 + [429]
    assert elsewhere.status_code == 401  # another address from the same IP is not blocked


async def test_login_per_ip_limit_counts_every_address(monkeypatch):
    monkeypatch.setattr(ratelimit, "LOGIN_IP", Limit("login:ip", 3, 900))
    async with _client() as c:
        codes = [
            (await c.post("/auth/login", json={"email": _nobody(), "password": "x"})).status_code
            for _ in range(4)
        ]
    assert codes == [401, 401, 401, 429]


async def test_forwarded_visitors_get_their_own_ip_budget(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    get_settings.cache_clear()
    monkeypatch.setattr(ratelimit, "LOGIN_IP", Limit("login:ip", 2, 900))
    async with _client() as c:
        async def attempt(ip: str) -> int:
            r = await c.post(
                "/auth/login", json={"email": _nobody(), "password": "x"}, headers={"X-Forwarded-For": ip}
            )
            return r.status_code

        visitor_a = [await attempt("198.51.100.1") for _ in range(3)]
        visitor_b = await attempt("198.51.100.2")
    assert visitor_a == [401, 401, 429]
    assert visitor_b == 401


async def test_register_is_limited_per_email(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    get_settings.cache_clear()
    email = _nobody()
    async with _client() as c:
        codes = [
            (await c.post("/auth/register", json={"email": email, "password": "x" * 12})).status_code
            for _ in range(6)
        ]
    try:
        assert codes == [201, 409, 409, 409, 409, 429]
    finally:
        from sqlalchemy import text

        from packages.db.session import get_engine

        async with get_engine().begin() as conn:
            slug = (
                await conn.execute(
                    text("SELECT t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id "
                         "JOIN core.users u ON u.id = m.user_id WHERE u.email = :e"),
                    {"e": email},
                )
            ).scalar_one_or_none()
            await conn.execute(text("DELETE FROM core.users WHERE email = :e"), {"e": email})
            if slug:
                await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
                await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))


async def test_endpoints_keep_working_when_redis_is_down(monkeypatch):
    monkeypatch.setattr(
        ratelimit, "_limiter", RateLimiter(RedisCounterStore("redis://unused", client=FakeRedis(down=True)))
    )
    async with _client() as c:
        codes = {
            (await c.post("/auth/login", json={"email": _nobody(), "password": "x"})).status_code
            for _ in range(15)
        }
    assert codes == {401}  # fail open: never 429, never 500
