"""The per-user billing row (``core.usage_accounts``) and its lock.

Every path that moves a user's limits or money — reserve, settle, a wallet
credit or debit, an admin window reset, a plan change — calls
``lock_account`` first, in the same transaction as the change. Lock order is
always account → run → wallet lots, so two of those paths can never
deadlock each other.
"""

from __future__ import annotations

from datetime import UTC, datetime

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


async def set_billing_anchor(
    session: AsyncSession, user_id: int, when: datetime | None
) -> int | None:
    """Store the day of the month the monthly allowance refills on.

    ``when`` is the subscription's billing-cycle anchor — the day the customer
    is actually invoiced. The MONTHLY window resets on it
    (packages/billing/runs.py), so it has to be readable without asking Stripe
    on every request; this is where the sync writes it down. Returns the day
    stored, or None when there was no date to take one from — the anchor is
    never cleared, so a subscription that ends keeps the day it renewed on and
    cannot hand out an extra reset by lapsing.

    The window START is deliberately left alone: if the anchor moved forward
    past it the next charge rolls the window, which is right — an invoice on a
    new date is a new period — and if it moved back the period the user is
    already in still contains it, so nothing is given away.
    """
    if when is None:
        return None
    day = when.astimezone(UTC).day
    account = await lock_account(session, int(user_id))
    if account.monthly_anchor_day != day:
        account.monthly_anchor_day = day
        await session.flush()
    return day


async def get_account(session: AsyncSession, user_id: int) -> UsageAccount | None:
    """Read without locking (views). None when the user never started a run."""
    return (
        await session.execute(
            select(UsageAccount)
            .where(UsageAccount.user_id == int(user_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
