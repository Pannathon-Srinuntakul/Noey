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
_POLL_MIN_SEC = 0.25
_POLL_MAX_SEC = 2.0


class VendorBusy(Exception):
    """Waited ``vendor_wait_max_sec`` for a vendor slot and got none."""

    def __init__(self, vendor: str) -> None:
        self.vendor = vendor
        super().__init__("ระบบ AI มีคิวหนาแน่น กรุณาลองใหม่อีกครั้ง")


# KEYS[1] request zset, KEYS[2] token zset
# ARGV: now_ms, window_ms, rpm, tpm, tokens, id
# Returns 0 when admitted, else the ms to wait before retrying.
_GEMINI_LUA = """
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local rpm = tonumber(ARGV[3])
local tpm = tonumber(ARGV[4])
local tokens = tonumber(ARGV[5])
local id = ARGV[6]
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
  return wait
end
redis.call('ZADD', KEYS[1], now, id)
redis.call('ZADD', KEYS[2], now, id .. ':' .. tokens)
redis.call('PEXPIRE', KEYS[1], window * 2)
redis.call('PEXPIRE', KEYS[2], window * 2)
return 0
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


def gemini_limits(model: str | None) -> tuple[str, int, int]:
    """(family, rpm, tpm) for a model id; 0 disables that limit."""
    from packages.core.settings import get_settings

    s = get_settings()
    family = rate_card.family_for(model)
    if family == "flash":
        return family, int(s.gemini_rpm_flash), int(s.gemini_tpm_flash)
    return family, int(s.gemini_rpm_pro), int(s.gemini_tpm_pro)


async def acquire_gemini(model: str | None, tokens: int, *, client: Any = None) -> None:
    """Wait for room in this model family's per-minute window, then take it.

    Only Gemini ids are limited (a local/other model passes straight through).
    """
    if "gemini" not in (model or "").lower():
        return
    family, rpm, tpm = gemini_limits(model)
    if rpm <= 0 and tpm <= 0:
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
    keys = [f"{PREFIX}:gemini:{family}:req", f"{PREFIX}:gemini:{family}:tok"]
    waited = False
    try:
        while True:
            try:
                wait_ms = int(
                    await redis.eval(_GEMINI_LUA, 2, *keys, _now_ms(), WINDOW_MS, rpm, tpm, max(0, int(tokens)), member)
                )
            except Exception as exc:  # noqa: BLE001 — fail open
                log.warning("vendor_limit_unavailable", vendor="gemini", error=str(exc)[:200], fail_open=True)
                return
            if wait_ms <= 0:
                if waited:
                    log.info("vendor_limit_admitted", vendor="gemini", family=family)
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
