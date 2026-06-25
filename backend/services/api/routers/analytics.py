from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from services.api import queries
from services.api.deps import db_session
from services.api.schemas import (
    DemographicsOut,
    FollowerHistoryRow,
    OverviewDailyRow,
    TiktokOverview,
    VideoRow,
    ViewersDailyRow,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview", response_model=TiktokOverview)
async def get_overview(
    start: date | None = None,
    end: date | None = None,
    session: AsyncSession = Depends(db_session),
) -> TiktokOverview:
    data = await queries.analytics_overview(session, start, end)
    return TiktokOverview(**data)


@router.get("/overview/timeseries", response_model=list[OverviewDailyRow])
async def get_overview_timeseries(
    start: date | None = None,
    end: date | None = None,
    session: AsyncSession = Depends(db_session),
) -> list[OverviewDailyRow]:
    rows = await queries.analytics_overview_timeseries(session, start, end)
    return [OverviewDailyRow(**r) for r in rows]


@router.get("/followers", response_model=list[FollowerHistoryRow])
async def get_followers(
    start: date | None = None,
    end: date | None = None,
    session: AsyncSession = Depends(db_session),
) -> list[FollowerHistoryRow]:
    rows = await queries.analytics_followers(session, start, end)
    return [FollowerHistoryRow(**r) for r in rows]


@router.get("/viewers", response_model=list[ViewersDailyRow])
async def get_viewers(
    start: date | None = None,
    end: date | None = None,
    session: AsyncSession = Depends(db_session),
) -> list[ViewersDailyRow]:
    rows = await queries.analytics_viewers(session, start, end)
    return [ViewersDailyRow(**r) for r in rows]


@router.get("/content", response_model=list[VideoRow])
async def get_content(
    start: date | None = None,
    end: date | None = None,
    limit: int = 100,
    session: AsyncSession = Depends(db_session),
) -> list[VideoRow]:
    rows = await queries.analytics_content(session, start, end, limit)
    return [VideoRow(**r) for r in rows]


@router.get("/demographics", response_model=DemographicsOut)
async def get_demographics(
    session: AsyncSession = Depends(db_session),
) -> DemographicsOut:
    data = await queries.analytics_demographics(session)
    return DemographicsOut(**data)
