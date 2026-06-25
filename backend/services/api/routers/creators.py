from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.api import queries
from services.api.deps import db_session
from services.api.schemas import CreatorRow

router = APIRouter(prefix="/creators", tags=["creators"])


@router.get("", response_model=list[CreatorRow])
async def list_creators(
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
    session: AsyncSession = Depends(db_session),
) -> list[CreatorRow]:
    rows = await queries.creators(session, start, end, limit)
    return [CreatorRow(**r) for r in rows]
