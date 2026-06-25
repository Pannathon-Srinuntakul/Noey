"""Background job status endpoints — polled by the frontend."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.core_auth import Job
from services.api.deps import core_session

router = APIRouter(prefix="/jobs", tags=["jobs"])


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
    session: AsyncSession = Depends(core_session),
) -> JobOut:
    job = (
        await session.execute(select(Job).where(Job.id == job_id))
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "job not found")
    return JobOut(
        id=str(job.id),
        type=str(job.type),
        status=str(job.status),
        progress=int(job.progress),
        result=job.result,
        error=job.error,
    )
