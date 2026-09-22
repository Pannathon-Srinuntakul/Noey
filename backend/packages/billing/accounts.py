"""The per-user billing row (``core.usage_accounts``) and its lock.

Every path that moves a user's limits or money — reserve, settle, a wallet
credit or debit, an admin window reset, a plan change — calls
``lock_account`` first, in the same transaction as the change. Lock order is
always account → run → wallet lots, so two of those paths can never
deadlock each other.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.usage_account import UsageAccount


async def lock_account(session: AsyncSession, user_id: int) -> UsageAccount:
    """The user's row, created if missing, locked FOR UPDATE until commit."""
    await session.execute(
        pg_insert(UsageAccount).values(user_id=int(user_id)).on_conflict_do_nothing()
    )
    return (
        await session.execute(
            select(UsageAccount)
            .where(UsageAccount.user_id == int(user_id))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def get_account(session: AsyncSession, user_id: int) -> UsageAccount | None:
    """Read without locking (views). None when the user never started a run."""
    return (
        await session.execute(
            select(UsageAccount)
            .where(UsageAccount.user_id == int(user_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
