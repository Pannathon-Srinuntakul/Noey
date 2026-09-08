from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models import AiRun
from services.api.deps import current_user, db_session
from services.api.schemas import RunOut

# Authenticated at the router: an AiRun row carries the model's raw output and,
# on failure, the provider's own error text — both of which name the vendor.
router = APIRouter(
    prefix="/runs",
    tags=["runs"],
    dependencies=[Depends(current_user)],
    include_in_schema=False,
)


@router.get("", response_model=list[RunOut])
async def list_runs(
    limit: int = 50,
    session: AsyncSession = Depends(db_session),
) -> list[RunOut]:
    rows = (
        (await session.execute(select(AiRun).order_by(AiRun.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return [
        RunOut(
            id=r.id,
            prompt_id=r.prompt_id,
            status=r.status,
            output=r.output,
            error=r.error,
            created_at=r.created_at,
        )
        for r in rows
    ]
