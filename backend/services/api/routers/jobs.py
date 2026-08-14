"""Background job status endpoints — polled by the frontend."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.core_auth import Job
from services.api.deps import CurrentUser, core_session

router = APIRouter(prefix="/jobs", tags=["jobs"])

# A running job whose row has not been touched for this long is treated as dead.
# Every task calls _update_job at each stage, and the longest silent stretch in
# any of them is a single LLM/STT call, which its own client times out well
# inside this window. Generous on purpose: reaping a job that is merely slow
# would be worse than leaving a dead one a few minutes longer.
_STALE_AFTER = timedelta(minutes=30)


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

    return JobOut(
        id=str(job.id),
        type=str(job.type),
        status=str(job.status),
        progress=int(job.progress),
        result=job.result,
        error=job.error,
    )
