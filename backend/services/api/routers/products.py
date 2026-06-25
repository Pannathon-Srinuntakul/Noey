from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.api import queries
from services.api.deps import db_session
from services.api.schemas import ProductRow

router = APIRouter(prefix="/products", tags=["products"])


@router.get("", response_model=list[ProductRow])
async def list_products(
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
    session: AsyncSession = Depends(db_session),
) -> list[ProductRow]:
    rows = await queries.products(session, start, end, limit)
    return [ProductRow(**r) for r in rows]
