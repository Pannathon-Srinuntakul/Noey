"""Insert DEMO data so the dashboard is visually populated before the scraper is wired.

Run:  python -m scripts.seed_demo
Clear: python -m scripts.seed_demo --clear
All demo ids are prefixed 'demo_' so they're easy to remove.
"""

import asyncio
import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import delete

from packages.db.models import Creator, Product, SalesDaily
from packages.db.session import get_sessionmaker
from packages.db.upserts import upsert_creator, upsert_product, upsert_sales_daily

PRODUCTS = [
    ("demo_p1", "Black Oversized Tee", 3000),
    ("demo_p2", "Cargo Pants", 2500),
    ("demo_p3", "Bucket Hat", 4000),
    ("demo_p4", "Chunky Sneakers", 1800),
    ("demo_p5", "Crossbody Bag", 3500),
    ("demo_p6", "Hoodie", 2800),
    ("demo_p7", "Sunglasses", 5000),
    ("demo_p8", "Phone Case", 6000),
]
CREATORS = [
    ("demo_c1", "@stylebya", "Style by A"),
    ("demo_c2", "@trendb", "Trend B"),
    ("demo_c3", "@dailyfit", "Daily Fit"),
]


async def seed() -> None:
    maker = get_sessionmaker()
    today = date.today()
    async with maker() as s:
        for pid, title, rate in PRODUCTS:
            await upsert_product(s, pid, title, rate)
        for cid, handle, name in CREATORS:
            await upsert_creator(s, cid, handle, name)
        i = 0
        for d in range(3):  # last 3 days
            day = today - timedelta(days=d)
            for pid, _, rate in PRODUCTS:
                cid = CREATORS[i % len(CREATORS)][0]
                units = (i * 7 + d * 3) % 50 + 5
                gmv = Decimal(units) * Decimal("199.00")
                commission = gmv * Decimal(rate) / Decimal(10000)
                await upsert_sales_daily(s, day, pid, cid, units, gmv, commission)
                i += 1
        await s.commit()
    print("seeded demo data")


async def clear() -> None:
    maker = get_sessionmaker()
    async with maker() as s:
        await s.execute(delete(SalesDaily).where(SalesDaily.product_id.like("demo_%")))
        await s.execute(delete(Product).where(Product.id.like("demo_%")))
        await s.execute(delete(Creator).where(Creator.id.like("demo_%")))
        await s.commit()
    print("cleared demo data")


if __name__ == "__main__":
    asyncio.run(clear() if "--clear" in sys.argv else seed())
