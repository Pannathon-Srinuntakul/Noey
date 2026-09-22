"""`GET /jobs/{id}` answers from Redis, and only when that is safe.

Polling this endpoint was 76% of all API traffic in the 2026-09-22 load test,
and each poll took a pooled Postgres connection to read a row that changes a
handful of times per job. The cache removes that cost — but it must never let a
caller see another tenant's job, and it must never hide a job whose worker died
(the stale reaper lives in the endpoint and needs the row).

No Postgres here: the session dependency is a fake that fails the test if the
cache path touches it.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from packages.db import job_cache
from services.api import deps
from services.api.main import app
from services.api.routers import jobs as jobs_router

JOB_ID = "vlocal_abc12345"


class _FakeAuth:
    def __init__(self, tenant_id: int = 7) -> None:
        self._tenant_id = tenant_id

    @property
    def tenant_id(self) -> int:
        return self._tenant_id

    @property
    def user_id(self) -> int:
        return 1


class _ExplodingSession:
    """Any database use at all is a failed test."""

    async def execute(self, *a, **k):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError("cache hit must not read the database")

    async def commit(self) -> None:
        raise AssertionError("cache hit must not write the database")


def _cached(
    *,
    tenant_id: int = 7,
    status: str = "running",
    age: timedelta = timedelta(seconds=5),
) -> dict:
    return {
        "id": JOB_ID,
        "tenant_id": tenant_id,
        "type": "plan_dub",
        "status": status,
        "progress": 40,
        "result": None,
        "error": None,
        "updated_at": (datetime.now(timezone.utc) - age).isoformat(),
    }


@pytest.fixture
def api(monkeypatch):
    """A client whose auth is tenant 7 and whose database raises on contact."""
    app.dependency_overrides[deps.current_user] = lambda: _FakeAuth(7)
    app.dependency_overrides[deps.core_session] = lambda: _ExplodingSession()
    yield AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    app.dependency_overrides.clear()


def _serve(monkeypatch, payload: dict | None) -> None:
    async def fake_get(job_id: str) -> dict | None:
        return payload

    monkeypatch.setattr(job_cache, "get", fake_get)


async def test_running_job_served_from_cache_without_touching_db(api, monkeypatch):
    _serve(monkeypatch, _cached())
    async with api as client:
        r = await client.get(f"/jobs/{JOB_ID}")
    assert r.status_code == 200
    assert r.json()["status"] == "running"
    assert r.json()["progress"] == 40


async def test_terminal_job_served_from_cache_however_old(api, monkeypatch):
    # A finished job never changes again, so age is irrelevant — and this is the
    # case that matters, because a client keeps polling until it sees it.
    _serve(monkeypatch, _cached(status="done", age=timedelta(days=3)))
    async with api as client:
        r = await client.get(f"/jobs/{JOB_ID}")
    assert r.status_code == 200
    assert r.json()["status"] == "done"


async def test_another_tenants_cached_job_is_never_served(api, monkeypatch):
    # The fake session raises, so reaching the row at all is what proves the
    # cache refused to answer — which is the behaviour we want.
    _serve(monkeypatch, _cached(tenant_id=999))
    async with api as client:
        with pytest.raises(AssertionError):
            await client.get(f"/jobs/{JOB_ID}")


async def test_stale_running_job_falls_through_to_the_reaper(api, monkeypatch):
    _serve(monkeypatch, _cached(age=timedelta(hours=2)))
    async with api as client:
        with pytest.raises(AssertionError):
            await client.get(f"/jobs/{JOB_ID}")


async def test_miss_falls_through(api, monkeypatch):
    _serve(monkeypatch, None)
    async with api as client:
        with pytest.raises(AssertionError):
            await client.get(f"/jobs/{JOB_ID}")


# ── the freshness rule itself ────────────────────────────────────────────────

def test_is_fresh_rules():
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(minutes=1)).isoformat()
    old = (now - timedelta(hours=1)).isoformat()

    assert jobs_router._is_fresh("done", old) is True
    assert jobs_router._is_fresh("error", old) is True
    assert jobs_router._is_fresh("running", recent) is True
    assert jobs_router._is_fresh("running", old) is False
    # Anything unparseable is treated as "read the row".
    assert jobs_router._is_fresh("running", "") is False
    assert jobs_router._is_fresh("running", "not-a-date") is False
    assert jobs_router._is_fresh("running", None) is False


def test_naive_timestamp_is_read_as_utc():
    # The worker writes `updated_at.isoformat()`, and the column is naive UTC —
    # reading it as local time would make every job look either stale or fresh
    # by the host's offset.
    naive = (datetime.now(timezone.utc) - timedelta(minutes=1)).replace(tzinfo=None)
    assert jobs_router._is_fresh("running", naive.isoformat()) is True


# ── the cache module ─────────────────────────────────────────────────────────

async def test_put_and_get_round_trip(monkeypatch):
    store: dict[str, str] = {}

    class _Redis:
        async def set(self, key, value, ex=None):  # noqa: ANN001, ANN202
            store[key] = value

        async def get(self, key):  # noqa: ANN001, ANN202
            return store.get(key)

    monkeypatch.setattr(job_cache, "_redis", lambda: _Redis())
    await job_cache.put(
        JOB_ID,
        tenant_id=7,
        job_type="plan_dub",
        status="running",
        progress=10,
        result={"a": 1},
        error=None,
        updated_at="2026-09-23T00:00:00+00:00",
    )
    assert json.loads(store[job_cache.key_for(JOB_ID)])["tenant_id"] == 7
    assert (await job_cache.get(JOB_ID))["result"] == {"a": 1}


async def test_redis_failure_is_never_an_error(monkeypatch):
    def broken():  # noqa: ANN202
        raise ConnectionError("down")

    monkeypatch.setattr(job_cache, "_redis", broken)
    # A cache that is down must degrade to "no cache", not to a failed request.
    await job_cache.put(
        JOB_ID,
        tenant_id=7,
        job_type="plan_dub",
        status="running",
        progress=0,
        result=None,
        error=None,
        updated_at="",
    )
    assert await job_cache.get(JOB_ID) is None
    await job_cache.drop(JOB_ID)
