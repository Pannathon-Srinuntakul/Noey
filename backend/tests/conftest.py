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
    # Windows are fixed wall-clock buckets (key = now // window). A test that
    # counts N hits and expects the N+1th to be refused fails whenever a
    # window boundary (e.g. :00/:15/:30/:45 for a 15-min rule) falls between
    # two of its requests — seen once as a flaky login-limit test. Pin the
    # limiter's wall clock to one instant so a test sees one
    # window; only `ratelimit`'s own `time` is replaced, and monotonic time
    # (the memory store's TTL) stays real.
    import types

    _frozen_wall = 1_700_000_000.0 + 1_800.0  # any fixed instant: a test sees one window
    monkeypatch.setattr(
        ratelimit,
        "time",
        types.SimpleNamespace(time=lambda: _frozen_wall, monotonic=ratelimit.time.monotonic),
    )
    # Refresh-token jtis likewise: a suite that logs in would otherwise write
    # 14-day keys into the developer's Redis on every run.
    from packages.auth import refresh_store

    monkeypatch.setattr(refresh_store, "_store", refresh_store.MemoryRefreshStore())
    # Sign in with Google: flow records in memory, and OFF unless a test
    # installs the fake (tests/google_fake.py) — a developer's .env may hold
    # real client credentials.
    from packages.auth import google_oauth

    monkeypatch.setattr(google_oauth, "_store", google_oauth.MemoryFlowStore())
    # Site -> editor sign-in handoff codes: in memory, never the developer's Redis.
    from packages.auth import handoff

    monkeypatch.setattr(handoff, "_store", handoff.MemoryHandoffStore())
    # The blog MCP server's refresh tokens: in memory too (own key prefix), and
    # blog revalidation never sleeps between retries nor calls a real site.
    from packages.blog import oauth as blog_oauth
    from packages.blog import revalidate as blog_revalidate

    monkeypatch.setattr(blog_oauth, "_store", refresh_store.MemoryRefreshStore(prefix=blog_oauth.REFRESH_PREFIX))
    monkeypatch.setattr(blog_revalidate, "BACKOFF", (0.0, 0.0))
    monkeypatch.setenv("BLOG_REVALIDATE_SECRET", "")
    monkeypatch.setenv("BLOG_MEDIA_PUBLIC_URL", "")
    monkeypatch.setenv("API_PUBLIC_URL", "http://localhost:8000")
    monkeypatch.setenv("ADMIN_URL", "http://localhost:3001")
    for var in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URIS"):
        monkeypatch.setenv(var, "")
    monkeypatch.setenv("SENDGRID_API_KEY", "")
    # A developer's .env may pick the SMTP transport or hold a Sentry DSN: no
    # test sends mail through it or reports an error anywhere.
    monkeypatch.setenv("EMAIL_TRANSPORT", "sendgrid")
    monkeypatch.setenv("SMTP_HOST", "")
    monkeypatch.setenv("SENTRY_DSN", "")
    # A developer's .env may turn the mock top-up on; tests opt in explicitly.
    monkeypatch.setenv("WALLET_MOCK_TOPUP", "false")
    # A developer's .env may hold REAL bucket credentials (a Railway bucket):
    # no test writes objects there. Tests that exercise the S3 layer stub its
    # client or `_s3_enabled` themselves.
    monkeypatch.setenv("S3_BUCKET", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _fresh_arq_pool():
    """The API's shared arq pool is module-level and bound to the event loop
    that opened it; every test runs on its own loop, so a pool left over from
    the previous test would answer with "Event loop is closed"."""
    from services.api import arq_pool

    arq_pool._pool = None
    yield
    arq_pool._pool = None


@pytest.fixture(autouse=True)
def _billing_stores_in_memory(monkeypatch):
    """Token billing's Redis-backed pieces never reach the developer's Redis.

    Free-tier counters get a fresh in-memory store; the vendor rate limiter
    fails open at once (tests that exercise it pass their own client); the
    circuit breaker's per-process caches start empty.
    """
    from packages.billing import free_tier, guard, vendor_limits

    monkeypatch.setattr(free_tier, "_store", free_tier.MemoryFreeTierStore())

    async def no_redis():
        raise ConnectionError("tests do not reach Redis")

    monkeypatch.setattr(vendor_limits, "_client", no_redis)
    monkeypatch.setattr(guard, "_alerted_days", set())
    guard.invalidate_cache()

    # The job-status cache is Redis too. It swallows its own errors, so a test
    # would still pass — but it would first spend the connect timeout on every
    # poll. Fail it instantly instead; a test that wants the cache patches this.
    from packages.db import job_cache

    def no_job_redis():
        raise ConnectionError("tests do not reach Redis")

    monkeypatch.setattr(job_cache, "_redis", no_job_redis)
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
    from packages.billing import fx as fx_mod
    from packages.billing import metering, vendor_cost

    outbox: list[str] = []

    async def push(table, row):
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
