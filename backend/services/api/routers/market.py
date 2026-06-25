from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.api import queries
from services.api.deps import db_session
from services.api.schemas import MarketRow

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/trends", response_model=list[MarketRow])
async def list_trends(
    limit: int = 100,
    session: AsyncSession = Depends(db_session),
) -> list[MarketRow]:
    rows = await queries.market_trends(session, limit)
    return [MarketRow(**r) for r in rows]
