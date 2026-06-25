"""Idempotency test for sales upsert — re-scraping a day must not duplicate.

Runs against the live Postgres (docker compose). Uses a transaction that is rolled back,
so it leaves no data behind.
"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from packages.db.models import SalesDaily
from packages.db.session import get_sessionmaker
from packages.db.upserts import upsert_creator, upsert_product, upsert_sales_daily

D = date(2026, 6, 15)


@pytest.mark.asyncio
async def test_sales_upsert_is_idempotent():
    maker = get_sessionmaker()
    async with maker() as s:
        await upsert_product(s, "test_p1", "Black Shirt", 3000)
        await upsert_creator(s, "test_c1", "@creatorA", "Creator A")

        await upsert_sales_daily(s, D, "test_p1", "test_c1", 10, Decimal("100.00"), Decimal("30.00"))
        await upsert_sales_daily(s, D, "test_p1", "test_c1", 12, Decimal("120.00"), Decimal("36.00"))
        await s.flush()

        count = await s.scalar(
            select(func.count())
            .select_from(SalesDaily)
            .where(
                SalesDaily.snapshot_date == D,
                SalesDaily.product_id == "test_p1",
                SalesDaily.creator_id == "test_c1",
            )
        )
        row = (
            await s.execute(
                select(SalesDaily).where(
                    SalesDaily.snapshot_date == D,
                    SalesDaily.product_id == "test_p1",
                    SalesDaily.creator_id == "test_c1",
                )
            )
        ).scalar_one()

        assert count == 1  # second upsert updated, did not duplicate
        assert row.units == 12
        assert row.gmv == Decimal("120.00")
        assert row.commission == Decimal("36.00")

        await s.rollback()  # leave DB clean
