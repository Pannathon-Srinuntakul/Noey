from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.api import queries
from services.api.deps import db_session
from services.api.schemas import Overview

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/overview", response_model=Overview)
async def overview(
    start: date | None = None,
    end: date | None = None,
    session: AsyncSession = Depends(db_session),
) -> Overview:
    data = await queries.overview(session, start, end)
    return Overview(**data)
