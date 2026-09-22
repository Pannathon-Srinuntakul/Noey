"""Cross-process vendor rate limits: bursts WAIT instead of failing.

Owner decision (docs/token-billing-plan.md §6): a system-wide queue per
vendor — requests and tokens per minute for Gemini, concurrent requests for
ElevenLabs — shared by every API and worker process through Redis.

- Gemini: a 60-second sliding window per model family (flash / pro), one
  Lua script checks and records both limits atomically. A call that does not
  fit waits (jittered) for the oldest entry to age out, up to
  ``settings.vendor_wait_max_sec``, then fails with ``VendorBusy``.
- ElevenLabs: a lease semaphore (sorted set scored by lease expiry, so a
  crashed holder frees its slot after ``STT_LEASE_SEC``).

FAIL OPEN, like services/api/ratelimit.py: with Redis unreachable the call
goes ahead (the vendor's own 429 plus the gateway's retry are the fallback).
The per-user reservation, which is what protects money, is in Postgres and
does not depend on this.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from packages.billing import rate_card
from packages.core.logging import get_logger

log = get_logger(__name__)

PREFIX = "noey:vl"
WINDOW_MS = 60_000
STT_LEASE_SEC = 120
#: The daily counter outlives its day by a margin, so a clock skew between
#: processes cannot resurrect a fresh counter mid-day.
_DAY_TTL_SEC = 36 * 60 * 60
_POLL_MIN_SEC = 0.25
_POLL_MAX_SEC = 2.0


class VendorBusy(Exception):
    """Waited ``vendor_wait_max_sec`` for a vendor slot and got none."""

    def __init__(self, vendor: str, message: str | None = None) -> None:
        self.vendor = vendor
        super().__init__(message or "ระบบ AI มีคิวหนาแน่น กรุณาลองใหม่อีกครั้ง")


class VendorDailyLimit(VendorBusy):
    """The vendor's requests-per-DAY quota is spent.

    Separate from VendorBusy because waiting is pointless: the quota resets at
    midnight Pacific, not in the next minute, so the caller must fail now rather
    than hold a job for ``vendor_wait_max_sec`` first.
    """

    def __init__(self, vendor: str) -> None:
        super().__init__(vendor, "โควตา AI ของวันนี้เต็มแล้ว ระบบจะกลับมาใช้ได้พรุ่งนี้")


# KEYS[1] request zset, KEYS[2] token zset, KEYS[3] today's request counter
# ARGV: now_ms, window_ms, rpm, tpm, tokens, id, rpd, day_ttl_sec
# Returns {wait_ms, requests_used_today}. wait_ms is 0 when admitted, -1 when
# the DAILY quota is gone (which no amount of waiting fixes before midnight
# Pacific), and otherwise the ms to wait before retrying.
_GEMINI_LUA = """
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local rpm = tonumber(ARGV[3])
local tpm = tonumber(ARGV[4])
local tokens = tonumber(ARGV[5])
local id = ARGV[6]
local rpd = tonumber(ARGV[7])
local day_ttl = tonumber(ARGV[8])
local day_used = tonumber(redis.call('GET', KEYS[3]) or '0')
if rpd > 0 and day_used >= rpd then
  return {-1, day_used}
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window)
local reqs = redis.call('ZCARD', KEYS[1])
local used = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  used = used + tonumber(string.match(m, ':(%d+)$'))
end
local over_rpm = rpm > 0 and reqs >= rpm
local over_tpm = tpm > 0 and used > 0 and used + tokens > tpm
if over_rpm or over_tpm then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local wait = 250
  if oldest[2] then wait = math.max(50, tonumber(oldest[2]) + window - now) end
  return {wait, day_used}
end
redis.call('ZADD', KEYS[1], now, id)
redis.call('ZADD', KEYS[2], now, id .. ':' .. tokens)
redis.call('PEXPIRE', KEYS[1], window * 2)
redis.call('PEXPIRE', KEYS[2], window * 2)
day_used = redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], day_ttl)
return {0, day_used}
"""

# KEYS[1] lease zset. ARGV: now_ms, lease_ms, max, id. Returns 1 / 0.
_SEMAPHORE_LUA = """
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
  return 1
end
return 0
"""


async def _client() -> Any:
    import redis.asyncio as aioredis

    from packages.core.settings import get_settings

    return aioredis.from_url(get_settings().redis_url, socket_timeout=2, socket_connect_timeout=2)


def _now_ms() -> int:
    return int(time.time() * 1000)


def gemini_limits(model: str | None) -> tuple[str, int, int, int]:
    """(family, rpm, tpm, rpd) for a model id; 0 disables that limit."""
    from packages.core.settings import get_settings

    s = get_settings()
    family = rate_card.family_for(model)
    if family == "flash":
        return family, int(s.gemini_rpm_flash), int(s.gemini_tpm_flash), int(s.gemini_rpd_flash)
    return family, int(s.gemini_rpm_pro), int(s.gemini_tpm_pro), int(s.gemini_rpd_pro)


def quota_day() -> str:
    """Today's key suffix, in the timezone the vendor resets on.

    Google's daily quotas roll over at midnight Pacific. Counting by UTC or by
    the server's local day would open a window where the counter has reset but
    the vendor's has not — exactly when a burst would hit 429s.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y%m%d")


#: (family, day) pairs already warned about, so one warning a day, not one per call.
_alerted: set[tuple[str, str]] = set()


def _maybe_alert(family: str, day: str, used: int, rpd: int) -> None:
    from packages.core.settings import get_settings

    if rpd <= 0:
        return
    ratio = float(get_settings().gemini_rpd_alert_ratio)
    if ratio <= 0 or used < rpd * ratio:
        return
    if (family, day) in _alerted:
        return
    _alerted.add((family, day))
    log.warning(
        "vendor_daily_quota_high",
        vendor="gemini",
        family=family,
        used=used,
        limit=rpd,
        percent=round(used * 100 / rpd, 1),
        day=day,
    )


async def acquire_gemini(model: str | None, tokens: int, *, client: Any = None) -> None:
    """Wait for room in this model family's per-minute window, then take it.

    Only Gemini ids are limited (a local/other model passes straight through).
    """
    if "gemini" not in (model or "").lower():
        return
    family, rpm, tpm, rpd = gemini_limits(model)
    if rpm <= 0 and tpm <= 0 and rpd <= 0:
        return
    from packages.core.settings import get_settings

    deadline = time.monotonic() + max(0, int(get_settings().vendor_wait_max_sec))
    own = client is None
    try:
        redis = client or await _client()
    except Exception as exc:  # noqa: BLE001 — fail open
        log.warning("vendor_limit_unavailable", vendor="gemini", error=str(exc)[:200], fail_open=True)
        return
    member = uuid.uuid4().hex
    day = quota_day()
    keys = [
        f"{PREFIX}:gemini:{family}:req",
        f"{PREFIX}:gemini:{family}:tok",
        f"{PREFIX}:gemini:{family}:rpd:{day}",
    ]
    waited = False
    try:
        while True:
            try:
                wait_ms, day_used = (
                    int(v)
                    for v in await redis.eval(
                        _GEMINI_LUA,
                        3,
                        *keys,
                        _now_ms(),
                        WINDOW_MS,
                        rpm,
                        tpm,
                        max(0, int(tokens)),
                        member,
                        rpd,
                        _DAY_TTL_SEC,
                    )
                )
            except Exception as exc:  # noqa: BLE001 — fail open
                log.warning("vendor_limit_unavailable", vendor="gemini", error=str(exc)[:200], fail_open=True)
                return
            if wait_ms < 0:
                log.warning(
                    "vendor_daily_quota_exhausted", vendor="gemini", family=family, used=day_used, limit=rpd, day=day
                )
                raise VendorDailyLimit("gemini")
            if wait_ms == 0:
                if waited:
                    log.info("vendor_limit_admitted", vendor="gemini", family=family)
                _maybe_alert(family, day, day_used, rpd)
                return
            if time.monotonic() >= deadline:
                log.warning("vendor_limit_timeout", vendor="gemini", family=family)
                raise VendorBusy("gemini")
            if not waited:
                log.info("vendor_limit_waiting", vendor="gemini", family=family, wait_ms=wait_ms)
            waited = True
            pause = min(_POLL_MAX_SEC, max(_POLL_MIN_SEC, wait_ms / 1000))
            await asyncio.sleep(pause * random.uniform(0.8, 1.2))
    finally:
        if own:
            try:
                await redis.aclose()
            except Exception as exc:  # noqa: BLE001 — closing must not mask the result
                log.debug("vendor_limit_close_failed", error=str(exc)[:200])


@asynccontextmanager
async def elevenlabs_slot(*, client: Any = None) -> AsyncIterator[None]:
    """Hold one of ``settings.elevenlabs_max_concurrency`` speech-to-text
    slots for the duration of one request."""
    from packages.core.settings import get_settings

    s = get_settings()
    cap = int(s.elevenlabs_max_concurrency)
    if cap <= 0:
        yield
        return
    own = client is None
    redis: Any = None
    member = uuid.uuid4().hex
    key = f"{PREFIX}:elevenlabs"
    held = False
    try:
        try:
            redis = client or await _client()
        except Exception as exc:  # noqa: BLE001
            log.warning("vendor_limit_unavailable", vendor="elevenlabs", error=str(exc)[:200], fail_open=True)
        if redis is not None:
            deadline = time.monotonic() + max(0, int(s.vendor_wait_max_sec))
            while True:
                try:
                    got = int(await redis.eval(_SEMAPHORE_LUA, 1, key, _now_ms(), STT_LEASE_SEC * 1000, cap, member))
                except Exception as exc:  # noqa: BLE001 — fail open
                    log.warning(
                        "vendor_limit_unavailable", vendor="elevenlabs", error=str(exc)[:200], fail_open=True
                    )
                    break
                if got:
                    held = True
                    break
                if time.monotonic() >= deadline:
                    raise VendorBusy("elevenlabs")
                await asyncio.sleep(random.uniform(_POLL_MIN_SEC, _POLL_MAX_SEC))
        yield
    finally:
        if held and redis is not None:
            try:
                await redis.zrem(key, member)
            except Exception as exc:  # noqa: BLE001 — the lease expires on its own
                log.warning("vendor_limit_release_failed", vendor="elevenlabs", error=str(exc)[:200])
        if own and redis is not None:
            try:
                await redis.aclose()
            except Exception as exc:  # noqa: BLE001 — closing must not mask the result
                log.debug("vendor_limit_close_failed", error=str(exc)[:200])


async def daily_usage(*, client: Any = None) -> dict[str, Any]:
    """Today's Gemini request count against the vendor's daily quota.

    Read-only, for the admin dashboard. Returns zeros rather than failing when
    Redis is unreachable: this is a view, and losing it must never take the
    dashboard down with it.
    """
    from packages.core.settings import get_settings

    day = quota_day()
    ratio = float(get_settings().gemini_rpd_alert_ratio)
    families = {
        "flash": int(get_settings().gemini_rpd_flash),
        "pro": int(get_settings().gemini_rpd_pro),
    }
    counts: dict[str, int] = {name: 0 for name in families}
    reachable = True
    own = client is None
    redis: Any = None
    try:
        redis = client or await _client()
        values = await redis.mget([f"{PREFIX}:gemini:{name}:rpd:{day}" for name in families])
        counts = {name: int(v or 0) for name, v in zip(families, values, strict=True)}
    except Exception as exc:  # noqa: BLE001 — a view, never a failure
        reachable = False
        log.debug("vendor_daily_usage_unavailable", error=str(exc)[:200])
    finally:
        if own and redis is not None:
            try:
                await redis.aclose()
            except Exception as exc:  # noqa: BLE001
                log.debug("vendor_limit_close_failed", error=str(exc)[:200])

    return {
        "day": day,
        "timezone": "America/Los_Angeles",
        "redis_reachable": reachable,
        "alert_ratio": ratio,
        "families": [
            {
                "family": name,
                "used": counts[name],
                "limit": limit,
                "percent": round(counts[name] * 100 / limit, 1) if limit > 0 else None,
                "alerting": limit > 0 and ratio > 0 and counts[name] >= limit * ratio,
            }
            for name, limit in families.items()
        ],
    }
