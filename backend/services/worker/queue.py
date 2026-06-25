"""arq pool factory + job-enqueue helpers used by the API.

The API calls enqueue_*() to submit heavy work to the worker process.
Each call:
  1. Creates a core.jobs row (pending) so the frontend can poll
  2. Enqueues the arq task
  3. Returns the job_id

The worker updates the core.jobs row as it runs.
"""

from __future__ import annotations

import uuid

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from sqlalchemy.ext.asyncio import AsyncSession

from packages.core.settings import get_settings
from packages.db.models.core_auth import Job


async def get_arq_pool() -> ArqRedis:
    settings = get_settings()
    return await create_pool(RedisSettings.from_dsn(settings.redis_url))


async def _create_job_row(
    session: AsyncSession,
    tenant_id: int,
    job_type: str,
    job_id: str,
) -> Job:
    job = Job(id=job_id, tenant_id=tenant_id, type=job_type, status="queued", progress=0)
    session.add(job)
    await session.flush()  # get the id without full commit
    return job


async def enqueue_csv_export(
    session: AsyncSession,
    tenant_id: int,
    tenant_slug: str,
    table_id: int,
    row_ids: list[int] | None = None,
) -> str:
    job_id = uuid.uuid4().hex
    await _create_job_row(session, tenant_id, "csv_export", job_id)
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "csv_export",
        job_id=job_id,
        tenant_slug=tenant_slug,
        table_id=table_id,
        row_ids=row_ids,
        _job_id=job_id,
    )
    await pool.aclose()
    return job_id


async def enqueue_csv_import(
    session: AsyncSession,
    tenant_id: int,
    tenant_slug: str,
    table_id: int,
    csv_data: str,
) -> str:
    job_id = uuid.uuid4().hex
    await _create_job_row(session, tenant_id, "csv_import", job_id)
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "csv_import",
        job_id=job_id,
        tenant_slug=tenant_slug,
        table_id=table_id,
        csv_data=csv_data,
        _job_id=job_id,
    )
    await pool.aclose()
    return job_id


async def enqueue_ai(
    session: AsyncSession,
    tenant_id: int,
    prompt: str,
) -> str:
    job_id = uuid.uuid4().hex
    await _create_job_row(session, tenant_id, "ai", job_id)
    pool = await get_arq_pool()
    await pool.enqueue_job("ai_process", job_id=job_id, prompt=prompt, _job_id=job_id)
    await pool.aclose()
    return job_id
