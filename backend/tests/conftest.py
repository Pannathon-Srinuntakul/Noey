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
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
async def _dispose_db_engine():
    yield
    from packages.db.session import get_engine, get_sessionmaker

    engine_cached = get_engine.cache_info().currsize > 0
    if engine_cached:
        await get_engine().dispose()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()
