"""One arq Redis pool per API process, opened at startup and reused.

``routers/videos.py:_enqueue`` used to build a fresh pool for every enqueue —
a TCP connect, a Redis handshake and a close per job start — and to time out
after 15 s when Redis was slow to answer that handshake. A pool that lives with
the process turns each enqueue into one round trip on an already-open
connection.

The lifespan in ``services/api/main.py`` warms it and closes it on shutdown.
Warming is best effort: an API that cannot reach Redis at boot still serves
everything that does not enqueue (login, project reads, downloads), and the
first enqueue retries the connection then. ``arq`` needs its own client rather
than ``packages/db/job_cache.py``'s: ``enqueue_job`` is a method of ``ArqRedis``.
"""

from __future__ import annotations

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from packages.core.logging import get_logger
from packages.core.settings import get_settings

log = get_logger(__name__)

_pool: ArqRedis | None = None


def _redis_settings() -> RedisSettings:
    settings = RedisSettings.from_dsn(get_settings().redis_url)
    # Same budget ``_enqueue`` used per call: a Redis that takes longer than
    # this is down for our purposes, and the caller gets a 503 rather than
    # a request that hangs.
    settings.conn_timeout = 5
    settings.conn_retries = 3
    return settings


async def get_arq_pool() -> ArqRedis:
    """The shared pool, created on first use if the startup warm-up failed.

    No lock: the lifespan warms the pool before the first request, so two
    callers only race here when that failed and Redis has just come back —
    the loser closes the pool it built. Cheaper than a lock that would have to
    be created per event loop (tests run each case on its own loop).
    """
    global _pool
    if _pool is not None:
        return _pool
    pool = await create_pool(_redis_settings())
    if _pool is None:
        _pool = pool
    else:
        await pool.aclose()
    return _pool


async def warm_arq_pool() -> bool:
    """Open the pool at startup. Returns False (and logs) when Redis is unreachable."""
    try:
        await get_arq_pool()
    except Exception as exc:  # noqa: BLE001 — boot must not depend on Redis
        log.error("arq_pool_warm_failed", error=str(exc)[:200])
        return False
    return True


async def close_arq_pool() -> None:
    """Close the pool (shutdown, or a test that wants the next call to reconnect)."""
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        await pool.aclose()
