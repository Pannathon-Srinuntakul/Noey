"""Migrate + seed run one at a time, however many processes start at once.

The API now runs with several uvicorn workers (API_WORKERS) and may run several
Railway replicas, so this block starts in N processes within the same second.
Two of them running `alembic upgrade head` and the seed concurrently against one
database is duplicate DDL and a racing `alembic_version` row.

Runs against the local Postgres; skipped when none is reachable.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text

from packages.db.session import get_lifeline_engine
from services.api.main import _startup_lock


@pytest.fixture
async def _needs_postgres():
    engine = get_lifeline_engine()
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        pytest.skip("no local Postgres")
    yield


async def test_two_starters_do_not_overlap(_needs_postgres):
    order: list[str] = []

    async def starter(name: str) -> None:
        async with _startup_lock():
            order.append(f"{name}:in")
            # Long enough that an unheld lock would interleave — the whole point
            # is that the second starter cannot enter here.
            await asyncio.sleep(0.3)
            order.append(f"{name}:out")

    await asyncio.gather(starter("a"), starter("b"))

    assert len(order) == 4
    # Whoever went first must leave before the other enters.
    assert order[0].endswith(":in") and order[1].endswith(":out")
    assert order[0].split(":")[0] == order[1].split(":")[0]
    assert order[2].split(":")[0] == order[3].split(":")[0]


async def test_the_lock_is_released_even_when_the_body_raises(_needs_postgres):
    # A failed migration must not leave the lock held: every later process would
    # then block at startup until the connection died.
    with pytest.raises(RuntimeError):
        async with _startup_lock():
            raise RuntimeError("migration blew up")

    async def quick() -> str:
        async with _startup_lock():
            return "acquired"

    assert await asyncio.wait_for(quick(), timeout=5) == "acquired"
