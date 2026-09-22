"""Background job status endpoints — polled by the frontend."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db import job_cache
from packages.db.models.core_auth import Job
from services.api.deps import CurrentUser, core_session

router = APIRouter(prefix="/jobs", tags=["jobs"])

# A running job whose row has not been touched for this long is treated as dead.
# Every task calls _update_job at each stage, and the longest silent stretch in
# any of them is a single LLM/STT call, which its own client times out well
# inside this window. Generous on purpose: reaping a job that is merely slow
# would be worse than leaving a dead one a few minutes longer.
_STALE_AFTER = timedelta(minutes=30)


def _is_fresh(status: object, updated_at: object) -> bool:
    """May the cached copy answer, or must the row be read?

    A terminal status never changes again, so it always may. A running one may
    only while it is younger than the stale-job window — past that the reaper in
    the endpoint below has to see the row to end it.
    """
    if status in ("ok", "done", "error", "cancelled"):
        return True
    if not isinstance(updated_at, str) or not updated_at:
        return False
    try:
        seen = datetime.fromisoformat(updated_at)
    except ValueError:
        return False
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - seen < _STALE_AFTER


class JobOut(BaseModel):
    id: str
    type: str
    status: str          # queued | running | ok | error
    progress: int        # 0-100
    result: dict | None
    error: str | None


@router.get("/{job_id}", response_model=JobOut)
async def get_job(
    job_id: str,
    auth: CurrentUser,
    session: AsyncSession = Depends(core_session),
) -> JobOut:
    """One job's status.

    Authenticated AND tenant-scoped. Both were missing: nothing in the app
    applies global auth (main.py mounts every router bare), and job ids are
    derived from the project uid (``vlocal_<uid[:8]>``), not random — so anyone
    who could reach the port could read another tenant's AI output, which for a
    re-edit includes the whole edit script with its voiceover text. A wrong
    tenant gets 404 rather than 403 so ids stay unenumerable.
    """
    # Redis first: this endpoint is the single busiest one in the app (76% of
    # requests under load, 2026-09-22), and a cached hit costs no database
    # connection. The cache is written by the worker right after the row is
    # committed, so a hit is never ahead of the row.
    cached = await job_cache.get(job_id)
    if cached is not None:
        try:
            same_tenant = int(cached.get("tenant_id", -1)) == auth.tenant_id
            fresh = same_tenant and _is_fresh(cached.get("status"), cached.get("updated_at"))
            out = (
                JobOut(
                    id=str(cached.get("id") or job_id),
                    type=str(cached.get("type") or ""),
                    status=str(cached.get("status") or ""),
                    progress=int(cached.get("progress") or 0),
                    result=cached.get("result"),
                    error=cached.get("error"),
                )
                if fresh
                else None
            )
        except (TypeError, ValueError):
            # A cache entry that does not parse is a cache miss, never a 500:
            # the row below is the source of truth and always available.
            out = None
        if out is not None:
            return out

    job = (
        await session.execute(select(Job).where(Job.id == job_id))
    ).scalar_one_or_none()
    if job is None or int(job.tenant_id) != auth.tenant_id:
        raise HTTPException(404, "job not found")

    # A worker that is killed (crash, redeploy, OOM) never writes a terminal
    # status, so the row stays "running" and the client polls it forever —
    # showing a progress bar for work that stopped hours ago, with no way to
    # start over because the project is still marked busy. Reap it here: this
    # endpoint is the only thing that ever looks at the row again.
    if str(job.status) in ("queued", "running"):
        updated = job.updated_at
        if updated is not None:
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - updated > _STALE_AFTER:
                job.status = "error"
                job.error = "งานหยุดไปเอง (worker หยุดทำงาน) — กดเริ่มใหม่ได้เลย"
                await session.commit()
                await job_cache.drop(job_id)

    return JobOut(
        id=str(job.id),
        type=str(job.type),
        status=str(job.status),
        progress=int(job.progress),
        result=job.result,
        error=job.error,
    )
