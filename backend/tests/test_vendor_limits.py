"""Cross-process vendor rate limits (packages/billing/vendor_limits.py).

The Lua scripts run on the local Redis under a throwaway key prefix (skipped
when no Redis is reachable); the fail-open path needs none.
"""

import time
import uuid

import pytest

from packages.billing import vendor_limits
from packages.core.settings import get_settings


@pytest.fixture
async def redis(monkeypatch):
    import redis.asyncio as aioredis

    client = aioredis.from_url(get_settings().redis_url, socket_timeout=1, socket_connect_timeout=1)
    try:
        await client.ping()
    except Exception:  # noqa: BLE001
        await client.aclose()
        pytest.skip("no local Redis")
    prefix = f"noey:test:vl:{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(vendor_limits, "PREFIX", prefix)
    yield client
    keys = [k async for k in client.scan_iter(f"{prefix}*")]
    if keys:
        await client.delete(*keys)
    await client.aclose()


def _limits(monkeypatch, **env):
    for key, value in env.items():
        monkeypatch.setenv(key, str(value))
    get_settings.cache_clear()


async def test_requests_per_minute_make_the_next_call_wait(monkeypatch, redis):
    _limits(monkeypatch, GEMINI_RPM_FLASH=2, GEMINI_TPM_FLASH=0, VENDOR_WAIT_MAX_SEC=0)
    await vendor_limits.acquire_gemini("gemini/gemini-3.7-flash", 10, client=redis)
    await vendor_limits.acquire_gemini("gemini/gemini-3.7-flash", 10, client=redis)
    with pytest.raises(vendor_limits.VendorBusy):
        await vendor_limits.acquire_gemini("gemini/gemini-3.7-flash", 10, client=redis)
    # The Pro family has its own window.
    await vendor_limits.acquire_gemini("gemini/gemini-3.1-pro-preview", 10, client=redis)


async def test_tokens_per_minute_count_across_calls(monkeypatch, redis):
    _limits(monkeypatch, GEMINI_RPM_FLASH=0, GEMINI_TPM_FLASH=1_000, VENDOR_WAIT_MAX_SEC=0)
    await vendor_limits.acquire_gemini("gemini-3.8-flash", 600, client=redis)
    with pytest.raises(vendor_limits.VendorBusy):
        await vendor_limits.acquire_gemini("gemini-3.8-flash", 600, client=redis)
    # One call bigger than the whole budget is still let through on an empty window.
    await redis.delete(f"{vendor_limits.PREFIX}:gemini:flash:req", f"{vendor_limits.PREFIX}:gemini:flash:tok")
    await vendor_limits.acquire_gemini("gemini-3.8-flash", 5_000, client=redis)


async def test_a_waiting_call_gets_in_once_the_window_moves(monkeypatch, redis):
    _limits(monkeypatch, GEMINI_RPM_FLASH=1, GEMINI_TPM_FLASH=0, VENDOR_WAIT_MAX_SEC=5)
    monkeypatch.setattr(vendor_limits, "WINDOW_MS", 400)
    await vendor_limits.acquire_gemini("gemini-3.7-flash", 1, client=redis)
    t0 = time.monotonic()
    await vendor_limits.acquire_gemini("gemini-3.7-flash", 1, client=redis)
    assert time.monotonic() - t0 >= 0.2


async def test_speech_to_text_concurrency_is_a_semaphore(monkeypatch, redis):
    _limits(monkeypatch, ELEVENLABS_MAX_CONCURRENCY=1, VENDOR_WAIT_MAX_SEC=0)
    async with vendor_limits.elevenlabs_slot(client=redis):
        with pytest.raises(vendor_limits.VendorBusy):
            async with vendor_limits.elevenlabs_slot(client=redis):
                pass
    async with vendor_limits.elevenlabs_slot(client=redis):  # released on exit
        pass


async def test_non_gemini_models_and_a_dead_redis_pass_straight_through(monkeypatch):
    # conftest makes every Redis connection fail: the limiter fails open.
    _limits(monkeypatch, GEMINI_RPM_FLASH=1, VENDOR_WAIT_MAX_SEC=0)
    for _ in range(3):
        await vendor_limits.acquire_gemini("gemini-3.7-flash", 1)
        await vendor_limits.acquire_gemini("ollama/llama3", 1)
        async with vendor_limits.elevenlabs_slot():
            pass
