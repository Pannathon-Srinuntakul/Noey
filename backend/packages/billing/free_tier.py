"""Free-tier abuse limits, per IP and per device (docs/token-billing-plan.md §6).

On top of email verification + Turnstile at sign-up, a FREE account may only
start AI work when its IP (and, when the client sends one, its device id —
header ``X-Noey-Device``, a random id the web keeps in localStorage and the
desktop in userData) has not already been used by too many other free
accounts or runs:

- at most ``settings.free_accounts_per_ip`` distinct free accounts may start
  AI work from one IP / device in 30 days;
- at most ``settings.free_runs_per_ip_day`` free AI runs per IP / device per
  UTC day.

Checking and counting are two steps: ``check_start`` (account-set membership
and the day's run count, READ only) runs before the reservation, and
``count_run`` (the increment) only after the reservation succeeded — a start
refused with 402 because the account's own limit is used up must not spend
the daily allowance every other free account behind the same NAT shares.

Identities are stored salted-hashed (``secret_key``), never raw. FAIL OPEN
like services/api/ratelimit.py: with Redis down the check passes — the plan's
own Monthly limit still bounds every account. Paid plans are never checked.
"""

from __future__ import annotations

import hashlib
import time
from datetime import UTC, datetime
from typing import Any, Protocol

from packages.core.logging import get_logger

log = get_logger(__name__)

ACCOUNTS_TTL_SEC = 30 * 86_400
RUNS_TTL_SEC = 2 * 86_400
DEVICE_HEADER = "x-noey-device"
FREE_TIER_MESSAGE = (
    "บัญชีฟรีจากเครือข่ายหรืออุปกรณ์นี้ใช้งาน AI ครบจำนวนที่กำหนดแล้ว — "
    "อัปเกรดแพลนเพื่อใช้งานต่อ หรือลองใหม่พรุ่งนี้"
)


class FreeTierLimited(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(FREE_TIER_MESSAGE)


def identity_hash(value: str | None) -> str | None:
    """Salted SHA-256 of an IP / device id (64 hex), or None for nothing."""
    raw = (value or "").strip()
    if not raw:
        return None
    from packages.core.settings import get_settings

    salt = get_settings().jwt_secret
    return hashlib.sha256(f"{salt}|{raw}".encode()).hexdigest()


class FreeTierStore(Protocol):
    async def admit_member(self, key: str, member: str, cap: int, ttl_sec: int) -> bool | None:
        """Add ``member`` unless the set already holds ``cap`` OTHER members.
        True = admitted (or already in), False = refused, None = store down."""
        ...

    async def incr(self, key: str, ttl_sec: int) -> int | None: ...

    async def get_count(self, key: str) -> int | None: ...


_ADMIT_LUA = """
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"""


class RedisFreeTierStore:
    _BREAKER_SEC = 30.0

    def __init__(self, url: str) -> None:
        self._url = url
        self._client: Any = None
        self._down_until = 0.0

    def _redis(self) -> Any:
        if self._client is None:
            import redis.asyncio as aioredis

            self._client = aioredis.from_url(self._url, socket_timeout=0.5, socket_connect_timeout=0.5)
        return self._client

    def _down(self, exc: BaseException) -> None:
        self._down_until = time.monotonic() + self._BREAKER_SEC
        log.warning("free_tier_store_unavailable", error=type(exc).__name__, fail_open=True)

    async def admit_member(self, key: str, member: str, cap: int, ttl_sec: int) -> bool | None:
        if time.monotonic() < self._down_until:
            return None
        try:
            return bool(int(await self._redis().eval(_ADMIT_LUA, 1, key, member, cap, ttl_sec)))
        except Exception as exc:  # noqa: BLE001 — fail open
            self._down(exc)
            return None

    async def get_count(self, key: str) -> int | None:
        if time.monotonic() < self._down_until:
            return None
        try:
            raw = await self._redis().get(key)
            return int(raw or 0)
        except Exception as exc:  # noqa: BLE001 — fail open
            self._down(exc)
            return None

    async def incr(self, key: str, ttl_sec: int) -> int | None:
        if time.monotonic() < self._down_until:
            return None
        try:
            async with self._redis().pipeline(transaction=True) as pipe:
                pipe.incr(key)
                pipe.expire(key, ttl_sec)
                count, _ = await pipe.execute()
            return int(count)
        except Exception as exc:  # noqa: BLE001
            self._down(exc)
            return None


class MemoryFreeTierStore:
    """In-process store — tests only."""

    def __init__(self) -> None:
        self.sets: dict[str, set[str]] = {}
        self.counts: dict[str, int] = {}

    async def admit_member(self, key: str, member: str, cap: int, ttl_sec: int) -> bool | None:
        members = self.sets.setdefault(key, set())
        if member in members:
            return True
        if len(members) >= cap:
            return False
        members.add(member)
        return True

    async def incr(self, key: str, ttl_sec: int) -> int | None:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def get_count(self, key: str) -> int | None:
        return self.counts.get(key, 0)


_store: FreeTierStore | None = None


def get_store() -> FreeTierStore:
    global _store
    if _store is None:
        from packages.core.settings import get_settings

        _store = RedisFreeTierStore(get_settings().redis_url)
    return _store


def _identities(ip: str | None, device: str | None) -> list[tuple[str, str]]:
    out = []
    for kind, raw in (("ip", ip), ("device", device)):
        digest = identity_hash(raw)
        if digest is not None:
            out.append((kind, digest))
    return out


def _runs_key(kind: str, digest: str) -> str:
    return f"noey:free:{kind}:{digest}:runs:{datetime.now(UTC).strftime('%Y%m%d')}"


async def check_start(*, user_id: int, ip: str | None, device: str | None) -> None:
    """Raise ``FreeTierLimited`` when this free account may not start AI work
    from this IP / device. Does NOT count the run — ``count_run`` does, once
    the reservation has succeeded."""
    from packages.core.settings import get_settings

    s = get_settings()
    store = get_store()
    for kind, digest in _identities(ip, device):
        admitted = await store.admit_member(
            f"noey:free:{kind}:{digest}:accounts", str(user_id), int(s.free_accounts_per_ip), ACCOUNTS_TTL_SEC
        )
        if admitted is False:
            log.info("free_tier_limited", reason=f"{kind}_accounts", user_id=user_id)
            raise FreeTierLimited(f"{kind}_accounts")
        runs = await store.get_count(_runs_key(kind, digest))
        if runs is not None and runs >= int(s.free_runs_per_ip_day):
            log.info("free_tier_limited", reason=f"{kind}_runs", user_id=user_id)
            raise FreeTierLimited(f"{kind}_runs")


async def count_run(*, ip: str | None, device: str | None) -> None:
    """Count one free AI run against the IP / device for today. Called only
    after the run was reserved. Never raises (fail open)."""
    store = get_store()
    for kind, digest in _identities(ip, device):
        try:
            await store.incr(_runs_key(kind, digest), RUNS_TTL_SEC)
        except Exception as exc:  # noqa: BLE001
            log.warning("free_tier_count_failed", error=str(exc)[:200])
