"""Test fixtures.

pytest-asyncio runs each async test in its own event loop. The DB engine is cached
(lru_cache) and binds to the loop that created it, so without cleanup a second test would
reuse an engine bound to a closed loop ("Event loop is closed"). This autouse fixture
disposes the engine on the current loop and clears the caches after every test, so each
test gets a fresh engine on its own loop.
"""

import pytest


@pytest.fixture(autouse=True)
def _no_redis_no_mail(monkeypatch):
    """No test reaches Redis or SendGrid.

    Every test gets a fresh in-memory rate-limit store (so counters never leak
    between tests, and no Redis client outlives its event loop), and email is
    off unless a test overrides the mailer dependency with a fake.
    """
    from packages.core.settings import get_settings
    from services.api import ratelimit

    monkeypatch.setattr(ratelimit, "_limiter", ratelimit.RateLimiter(ratelimit.MemoryCounterStore()))
    monkeypatch.setenv("SENDGRID_API_KEY", "")
    # A developer's .env may turn the mock top-up on; tests opt in explicitly.
    monkeypatch.setenv("WALLET_MOCK_TOPUP", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _billing_stores_in_memory(monkeypatch):
    """Token billing's Redis-backed pieces never reach the developer's Redis.

    Free-tier counters get a fresh in-memory store; the vendor rate limiter
    fails open at once (tests that exercise it pass their own client); the
    circuit breaker's per-process caches start empty.
    """
    from packages.billing import free_tier, guard, vendor_limits

    monkeypatch.setattr(free_tier, "_store", free_tier.MemoryFreeTierStore())

    async def no_redis():  # noqa: ANN202
        raise ConnectionError("tests do not reach Redis")

    monkeypatch.setattr(vendor_limits, "_client", no_redis)
    monkeypatch.setattr(guard, "_alerted_days", set())
    guard.invalidate_cache()
    yield
    guard.invalidate_cache()


@pytest.fixture(autouse=True)
async def _dispose_db_engine():
    yield
    from packages.db.session import get_engine, get_sessionmaker

    engine_cached = get_engine.cache_info().currsize > 0
    if engine_cached:
        await get_engine().dispose()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()


@pytest.fixture(autouse=True)
def _usage_outbox_in_memory(monkeypatch):
    """Usage recording never reaches the real Redis outbox, and never sleeps.

    A test whose usage row cannot be written (no such user, …) would otherwise
    retry with real delays and then push its row into the developer's Redis,
    where the worker's drain cron would keep failing on it. Tests that care
    read ``metering.TEST_OUTBOX``.
    """
    from packages.billing import metering, vendor_cost
    from packages.billing import fx as fx_mod

    outbox: list[str] = []

    async def push(table, row):  # noqa: ANN001
        outbox.append(metering._to_json(table, row))
        return True

    monkeypatch.setattr(metering, "_push_outbox", push)
    monkeypatch.setattr(metering, "RETRY_DELAYS", (0.0, 0.0, 0.0))
    monkeypatch.setattr(metering, "TEST_OUTBOX", outbox, raising=False)
    # Price caches are per process; a test that edits prices must not leak.
    vendor_cost.invalidate_cache()
    fx_mod.invalidate_cache()
    yield
    vendor_cost.invalidate_cache()
    fx_mod.invalidate_cache()
