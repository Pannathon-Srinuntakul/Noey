"""Idempotent upserts. Re-importing the same data must never duplicate rows.

Callers manage the transaction (flush/commit). These just stage the statements.
"""

from datetime import date
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models import Creator, Product, SalesDaily
from packages.db.models.tiktok_csv import (
    FollowerActivity,
    FollowerGender,
    FollowerHistory,
    FollowerTerritory,
    OverviewDaily,
    VideoContent,
    ViewersDaily,
)


async def upsert_product(
    session: AsyncSession, id: str, title: str, commission_rate: int | None = None
) -> None:
    stmt = pg_insert(Product).values(id=id, title=title, commission_rate=commission_rate)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Product.id],
        set_={"title": stmt.excluded.title, "commission_rate": stmt.excluded.commission_rate},
    )
    await session.execute(stmt)


async def upsert_creator(
    session: AsyncSession, id: str, handle: str | None = None, name: str | None = None
) -> None:
    stmt = pg_insert(Creator).values(id=id, handle=handle, name=name)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Creator.id],
        set_={"handle": stmt.excluded.handle, "name": stmt.excluded.name},
    )
    await session.execute(stmt)


async def upsert_sales_daily(
    session: AsyncSession,
    snapshot_date: date,
    product_id: str,
    creator_id: str,
    units: int,
    gmv: Decimal | float,
    commission: Decimal | float,
) -> None:
    """Upsert one daily snapshot keyed on (snapshot_date, product_id, creator_id)."""
    stmt = pg_insert(SalesDaily).values(
        snapshot_date=snapshot_date,
        product_id=product_id,
        creator_id=creator_id,
        units=units,
        gmv=gmv,
        commission=commission,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            SalesDaily.snapshot_date,
            SalesDaily.product_id,
            SalesDaily.creator_id,
        ],
        set_={
            "units": stmt.excluded.units,
            "gmv": stmt.excluded.gmv,
            "commission": stmt.excluded.commission,
            "captured_at": func.now(),
        },
    )
    await session.execute(stmt)


# ── TikTok CSV analytics upserts ────────────────────────────────────────────


async def upsert_overview_daily(
    session: AsyncSession,
    export_date: date,
    row_date: date,
    video_views: int,
    profile_views: int,
    likes: int,
    comments: int,
    shares: int,
) -> None:
    stmt = pg_insert(OverviewDaily).values(
        export_date=export_date,
        date=row_date,
        video_views=video_views,
        profile_views=profile_views,
        likes=likes,
        comments=comments,
        shares=shares,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[OverviewDaily.export_date, OverviewDaily.date],
        set_={
            "video_views": stmt.excluded.video_views,
            "profile_views": stmt.excluded.profile_views,
            "likes": stmt.excluded.likes,
            "comments": stmt.excluded.comments,
            "shares": stmt.excluded.shares,
        },
    )
    await session.execute(stmt)


async def upsert_video_content(
    session: AsyncSession,
    export_date: date,
    video_id: str,
    video_url: str,
    video_title: str,
    post_date: date | None,
    likes: int,
    comments: int,
    shares: int,
    views: int,
) -> None:
    stmt = pg_insert(VideoContent).values(
        export_date=export_date,
        video_id=video_id,
        video_url=video_url,
        video_title=video_title,
        post_date=post_date,
        likes=likes,
        comments=comments,
        shares=shares,
        views=views,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[VideoContent.export_date, VideoContent.video_id],
        set_={
            "video_url": stmt.excluded.video_url,
            "video_title": stmt.excluded.video_title,
            "post_date": stmt.excluded.post_date,
            "likes": stmt.excluded.likes,
            "comments": stmt.excluded.comments,
            "shares": stmt.excluded.shares,
            "views": stmt.excluded.views,
        },
    )
    await session.execute(stmt)


async def upsert_follower_history(
    session: AsyncSession,
    export_date: date,
    row_date: date,
    followers: int,
    net_change: int,
) -> None:
    stmt = pg_insert(FollowerHistory).values(
        export_date=export_date,
        date=row_date,
        followers=followers,
        net_change=net_change,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[FollowerHistory.export_date, FollowerHistory.date],
        set_={"followers": stmt.excluded.followers, "net_change": stmt.excluded.net_change},
    )
    await session.execute(stmt)


async def upsert_follower_activity(
    session: AsyncSession,
    export_date: date,
    row_date: date,
    hour: int,
    active_followers: int,
) -> None:
    stmt = pg_insert(FollowerActivity).values(
        export_date=export_date,
        date=row_date,
        hour=hour,
        active_followers=active_followers,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            FollowerActivity.export_date,
            FollowerActivity.date,
            FollowerActivity.hour,
        ],
        set_={"active_followers": stmt.excluded.active_followers},
    )
    await session.execute(stmt)


async def upsert_follower_gender(
    session: AsyncSession,
    export_date: date,
    gender: str,
    distribution: float,
) -> None:
    stmt = pg_insert(FollowerGender).values(
        export_date=export_date,
        gender=gender,
        distribution=distribution,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[FollowerGender.export_date, FollowerGender.gender],
        set_={"distribution": stmt.excluded.distribution},
    )
    await session.execute(stmt)


async def upsert_follower_territory(
    session: AsyncSession,
    export_date: date,
    territory: str,
    distribution: float,
) -> None:
    stmt = pg_insert(FollowerTerritory).values(
        export_date=export_date,
        territory=territory,
        distribution=distribution,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[FollowerTerritory.export_date, FollowerTerritory.territory],
        set_={"distribution": stmt.excluded.distribution},
    )
    await session.execute(stmt)


async def upsert_viewers_daily(
    session: AsyncSession,
    export_date: date,
    row_date: date,
    total_viewers: int | None,
    new_viewers: int | None,
    returning_viewers: int | None,
) -> None:
    stmt = pg_insert(ViewersDaily).values(
        export_date=export_date,
        date=row_date,
        total_viewers=total_viewers,
        new_viewers=new_viewers,
        returning_viewers=returning_viewers,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[ViewersDaily.export_date, ViewersDaily.date],
        set_={
            "total_viewers": stmt.excluded.total_viewers,
            "new_viewers": stmt.excluded.new_viewers,
            "returning_viewers": stmt.excluded.returning_viewers,
        },
    )
    await session.execute(stmt)
