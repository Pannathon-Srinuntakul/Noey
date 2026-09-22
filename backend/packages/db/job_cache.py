"""Job status in Redis, so polling does not cost a database connection.

`GET /jobs/{id}` was **76% of all API requests** in the 2026-09-22 load test
(20,748 of 27,228 at 100 concurrent users) and every one of them checked out a
pooled Postgres connection to read a row that changes a handful of times per
job. The worker writes each status change here as well, and the endpoint reads
this first; Postgres is touched only on a miss, for the stale-job reaper, or
when Redis is unreachable.

Redis is a cache, never the source of truth: every value written here was
already committed to `core.jobs`, and every read falls back to the row.
"""

from __future__ import annotations

import json
from typing import Any

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

#: Long enough to cover a whole run (job_timeout is 3 h) without keeping dead
#: jobs around for days.
TTL_SEC = 4 * 60 * 60

_client: Any | None = None


def _redis() -> Any:
    global _client
    if _client is None:
        import redis.asyncio as aioredis

        # Short timeouts: the cache must never be the reason a request is slow.
        # A miss costs one database read, which is what used to happen anyway.
        _client = aioredis.from_url(
            get_settings().redis_url, socket_timeout=0.5, socket_connect_timeout=0.5
        )
    return _client


def key_for(job_id: str) -> str:
    return f"noey:job:{job_id}"


async def put(
    job_id: str,
    *,
    tenant_id: int,
    job_type: str,
    status: str,
    progress: int,
    result: dict | None,
    error: str | None,
    updated_at: str,
) -> None:
    """Cache one job's state. Never raises — a cache that is down is not an error."""
    payload = {
        "id": job_id,
        "tenant_id": int(tenant_id),
        "type": job_type,
        "status": status,
        "progress": int(progress),
        "result": result,
        "error": error,
        "updated_at": updated_at,
    }
    try:
        await _redis().set(key_for(job_id), json.dumps(payload, ensure_ascii=False), ex=TTL_SEC)
    except Exception as exc:  # noqa: BLE001 — cache write must not fail a job
        log.debug("job_cache_write_failed", job_id=job_id, error=str(exc)[:120])


async def get(job_id: str) -> dict | None:
    """The cached state, or None on a miss or any Redis trouble."""
    try:
        raw = await _redis().get(key_for(job_id))
    except Exception as exc:  # noqa: BLE001
        log.debug("job_cache_read_failed", job_id=job_id, error=str(exc)[:120])
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def drop(job_id: str) -> None:
    """Forget a job — used when the row is changed outside the worker."""
    try:
        await _redis().delete(key_for(job_id))
    except Exception as exc:  # noqa: BLE001
        log.debug("job_cache_drop_failed", job_id=job_id, error=str(exc)[:120])
