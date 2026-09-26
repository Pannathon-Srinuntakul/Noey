"""`/health` is liveness and touches nothing; `/health/ready` proves DB + Redis.

The Redis probe is pointed at a closed local port (connection refused answers
at once, well inside the 1 s budget) rather than the developer's real Redis, so
the "redis down" cases are deterministic. The DB probe runs against the local
Postgres when there is one, and is monkeypatched otherwise.
"""

from __future__ import annotations

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from packages.core.settings import get_settings
from packages.db.session import get_lifeline_engine
from services.api import main as api_main
from services.api.main import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def _has_postgres():
    try:
        async with get_lifeline_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        pytest.skip("no local Postgres")


@pytest.fixture
def _redis_unreachable(monkeypatch):
    # Port 9 (discard) is never listening on a developer machine: the connect
    # is refused immediately instead of hanging until the timeout.
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:9/0")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_liveness_is_a_static_ok():
    async with _client() as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_ready_reports_each_dependency(_has_postgres, _redis_unreachable):
    async with _client() as c:
        r = await c.get("/health/ready")
    assert r.status_code == 503
    assert r.json() == {"status": "fail", "db": "ok", "redis": "fail"}


async def test_ready_is_200_when_both_answer(_has_postgres, monkeypatch):
    async def redis_ok() -> bool:
        return True

    monkeypatch.setattr(api_main, "_redis_ready", redis_ok)
    async with _client() as c:
        r = await c.get("/health/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "db": "ok", "redis": "ok"}


async def test_ready_names_the_database_when_it_fails(monkeypatch, _redis_unreachable):
    async def db_down() -> bool:
        return False

    monkeypatch.setattr(api_main, "_db_ready", db_down)
    async with _client() as c:
        r = await c.get("/health/ready")
    assert r.status_code == 503
    assert r.json() == {"status": "fail", "db": "fail", "redis": "fail"}


async def test_db_probe_gives_up_within_the_budget(monkeypatch):
    """A database that accepts the connection and then never answers must not
    hold the probe — Railway would count the slow reply as a failure anyway,
    but a hung probe also hides WHICH dependency is stuck."""

    class _HangingConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, *_a, **_k):
            await asyncio.sleep(30)

    class _HangingEngine:
        def connect(self):
            return _HangingConn()

    monkeypatch.setattr(api_main, "_READY_TIMEOUT_SEC", 0.05)
    from packages.db import session as db_session

    monkeypatch.setattr(db_session, "get_lifeline_engine", lambda: _HangingEngine())
    assert await asyncio.wait_for(api_main._db_ready(), timeout=2) is False


async def test_redis_probe_is_false_on_refused_connection(_redis_unreachable):
    assert await asyncio.wait_for(api_main._redis_ready(), timeout=2) is False
