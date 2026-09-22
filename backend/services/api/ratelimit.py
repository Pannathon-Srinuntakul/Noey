"""Fixed-window rate limits in Redis (the arq Redis, REDIS_URL).

Each rule counts hits of one identity (an email, an account id, an IP) in the
current window: key `noey:rl:<rule>:<sha256(identity)>:<window index>`, INCR +
EXPIRE in one round trip. Identities are hashed — no address or IP is stored.

Per-email / per-account rules are listed (and checked) first; per-IP rules
are secondary and looser, because many honest people can share one IP.

FAIL OPEN: if Redis is unreachable the request is allowed and a warning is
logged; the store then skips Redis for 30 s so an outage does not add a
connection timeout to every request. Defaults: docs/email-sendgrid.md.
"""

import hashlib
import math
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException, Request
from redis.exceptions import RedisError

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)


@dataclass(frozen=True)
class Limit:
    name: str
    max_hits: int
    window_sec: int


_15_MIN = 15 * 60
_HOUR = 60 * 60

LOGIN_EMAIL_IP = Limit("login:email_ip", 10, _15_MIN)
LOGIN_IP = Limit("login:ip", 100, _15_MIN)
REGISTER_EMAIL = Limit("register:email", 5, _HOUR)
REGISTER_IP = Limit("register:ip", 20, _HOUR)
#: Free-tier abuse (docs/token-billing-plan.md §6): new accounts per IP per
#: day, on top of the hourly burst limit above.
REGISTER_IP_DAY = Limit("register:ip_day", 5, 24 * _HOUR)
FORGOT_EMAIL = Limit("forgot_password:email", 3, _HOUR)
FORGOT_IP = Limit("forgot_password:ip", 20, _HOUR)
RESEND_ACCOUNT = Limit("resend_verification:account", 3, _HOUR)
RESEND_IP = Limit("resend_verification:ip", 20, _HOUR)
CHANGE_EMAIL_ACCOUNT = Limit("change_email:account", 5, _HOUR)
CHANGE_EMAIL_IP = Limit("change_email:ip", 20, _HOUR)
CONTACT_EMAIL = Limit("contact:email", 3, _HOUR)
CONTACT_IP = Limit("contact:ip", 10, _HOUR)
#: change-password checks the current password: a stolen session token must
#: not be able to guess it without limit.
CHANGE_PASSWORD_ACCOUNT = Limit("change_password:account", 10, _15_MIN)
#: The wizard re-asks for an estimate as files / mode / precision change
#: (debounced client-side); this only stops a runaway loop.
USAGE_ESTIMATE_ACCOUNT = Limit("usage_estimate:account", 60, 60)

#: Admin dashboard login (services/api/routers/admin.py). Tighter than the
#: public login: there are a handful of admins, and each step is guarded twice
#: (these counters, plus the database-backed lockout in packages/admin/auth.py,
#: which does not fail open).
ADMIN_LOGIN_EMAIL = Limit("admin_login:email", 10, _15_MIN)
ADMIN_LOGIN_IP = Limit("admin_login:ip", 30, _15_MIN)
ADMIN_OTP_CHALLENGE = Limit("admin_otp:challenge", 10, _15_MIN)
ADMIN_OTP_IP = Limit("admin_otp:ip", 30, _15_MIN)
ADMIN_RESEND_CHALLENGE = Limit("admin_resend:challenge", 3, _HOUR)
ADMIN_RESEND_IP = Limit("admin_resend:ip", 10, _HOUR)
ADMIN_REFRESH_IP = Limit("admin_refresh:ip", 240, _15_MIN)

ALL_LIMITS: tuple[Limit, ...] = (
    LOGIN_EMAIL_IP, LOGIN_IP, REGISTER_EMAIL, REGISTER_IP, REGISTER_IP_DAY, FORGOT_EMAIL, FORGOT_IP,
    RESEND_ACCOUNT, RESEND_IP, CHANGE_EMAIL_ACCOUNT, CHANGE_EMAIL_IP, CONTACT_EMAIL, CONTACT_IP,
    CHANGE_PASSWORD_ACCOUNT, USAGE_ESTIMATE_ACCOUNT, ADMIN_LOGIN_EMAIL, ADMIN_LOGIN_IP, ADMIN_OTP_CHALLENGE, ADMIN_OTP_IP,
    ADMIN_RESEND_CHALLENGE, ADMIN_RESEND_IP, ADMIN_REFRESH_IP,
)


class CounterStore(Protocol):
    async def incr(self, key: str, ttl_sec: int) -> int | None:
        """The key's count after this hit, or None when the store is unavailable."""
        ...


class RedisCounterStore:
    """The production store: INCR + EXPIRE in one pipeline round trip."""

    _BREAKER_SEC = 30.0

    def __init__(self, url: str, *, client: Any = None) -> None:
        self._url = url
        self._client = client
        self._down_until = 0.0

    def _redis(self) -> Any:
        if self._client is None:
            import redis.asyncio as aioredis

            # Short timeouts: a limiter that cannot answer fast must not hold
            # the request hostage — it fails open instead.
            self._client = aioredis.from_url(
                self._url, socket_timeout=0.5, socket_connect_timeout=0.5
            )
        return self._client

    async def incr(self, key: str, ttl_sec: int) -> int | None:
        if time.monotonic() < self._down_until:
            return None
        try:
            async with self._redis().pipeline(transaction=True) as pipe:
                pipe.incr(key)
                pipe.expire(key, ttl_sec)
                count, _ = await pipe.execute()
            return int(count)
        except (RedisError, OSError, TimeoutError) as exc:
            self._down_until = time.monotonic() + self._BREAKER_SEC
            log.warning("rate_limit_store_unavailable", error=type(exc).__name__, fail_open=True)
            return None


class MemoryCounterStore:
    """In-process store — tests, and nothing else (it is per process)."""

    def __init__(self) -> None:
        self.counts: dict[str, tuple[int, float]] = {}

    async def incr(self, key: str, ttl_sec: int) -> int | None:
        now = time.monotonic()
        count, expires = self.counts.get(key, (0, now + ttl_sec))
        if expires <= now:
            count, expires = 0, now + ttl_sec
        self.counts[key] = (count + 1, expires)
        return count + 1


def _thai_detail(retry_after: int) -> str:
    minutes = max(1, math.ceil(retry_after / 60))
    return f"ทำรายการถี่เกินไป กรุณาลองใหม่อีกครั้งในอีกประมาณ {minutes} นาที"


class RateLimiter:
    def __init__(self, store: CounterStore) -> None:
        self.store = store

    async def check(self, rules: Sequence[tuple[Limit, str | None]]) -> None:
        """Count one hit on every rule, in order; 429 on the first one over its limit."""
        for limit, identity in rules:
            if not identity:
                continue
            now = time.time()
            window = int(now // limit.window_sec)
            digest = hashlib.sha256(identity.strip().lower().encode("utf-8")).hexdigest()[:32]
            count = await self.store.incr(f"noey:rl:{limit.name}:{digest}:{window}", limit.window_sec)
            if count is not None and count > limit.max_hits:
                retry_after = max(1, int(limit.window_sec - (now % limit.window_sec)))
                log.info("rate_limited", rule=limit.name, retry_after=retry_after)
                raise HTTPException(
                    status_code=429,
                    detail=_thai_detail(retry_after),
                    headers={"Retry-After": str(retry_after)},
                )


_limiter: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    """The process-wide limiter (tests swap `_limiter` for an in-memory one)."""
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter(RedisCounterStore(get_settings().redis_url))
    return _limiter


async def enforce(rules: Sequence[tuple[Limit, str | None]]) -> None:
    await get_limiter().check(rules)


def client_ip(request: Request) -> str:
    """The client's IP: the socket peer, or — behind TRUSTED_PROXY_HOPS trusted
    proxies — the X-Forwarded-For entry that many places from the right.

    Each proxy appends the address it received the connection from, so with N
    trusted proxies the Nth entry from the right is the last address no
    client could have forged. A chain shorter than N (a request that came
    through fewer proxies, e.g. over a private network) falls back to its
    leftmost entry.
    """
    peer = request.client.host if request.client else "unknown"
    hops = get_settings().trusted_proxy_hops
    if hops <= 0:
        return peer
    chain = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",")]
    chain = [part for part in chain if part]
    if not chain:
        return peer
    return chain[max(len(chain) - hops, 0)]
