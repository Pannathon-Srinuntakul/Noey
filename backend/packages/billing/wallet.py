"""The top-up wallet: a baht balance for usage beyond the plan's windows.

Owner decisions (docs/token-billing-plan.md §6): the user sees baht, never
tokens; ฿350 per 1M tokens (``rate_card.TOPUP_SATANG_PER_1M``); packs
฿100 / ฿300 / ฿500 / ฿1,000, PromptPay offered first; each purchase is valid
12 months; the balance is used only once the plan's windows are exhausted
(packages/billing/runs.py decides that) and only for a run the user started
with "continue with my balance".

Money moves in satang (integers). Lots are consumed FIFO by expiry, so the
baht closest to expiring go first. Each movement writes one signed ledger row
with the balance after it. Callers hold the ``usage_accounts`` lock
(packages/billing/accounts.py) for the whole transaction; this module takes
it itself where it is the entry point (credit, adjust, expiry).

Refunds: a run is debited only when it settles, and a run that failed
because of us settles at zero (runs.py), so "refund on our failure" means
the held baht are simply released — nothing is taken. ``refund`` exists for
the one case money already left: returning a settled debit (admin / support),
credited back to the lot it came from.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import rate_card
from packages.billing.accounts import lock_account
from packages.core.logging import get_logger
from packages.db.models.usage_account import UsageAccount
from packages.db.models.wallet import WalletLedger, WalletLot

log = get_logger(__name__)

PACKS_SATANG: tuple[int, ...] = (10_000, 30_000, 50_000, 100_000)
#: Checkout offers PromptPay first: 1.65% vs card 3.65% + ฿10.
METHODS: tuple[str, ...] = ("promptpay", "card")
LOT_VALID_DAYS = 365
HISTORY_ROWS = 30
#: A chargeback / refund of top-up baht that were ALREADY SPENT, and that the
#: user's other lots could not cover, is carried as DEBT: a lot of this source
#: with NEGATIVE remaining. It nets against the balance (so no wallet spending
#: happens while it is owed) and the next money credited pays it off first. An
#: admin clears it by crediting (``adjust``) — the credit repays it.
DEBT_SOURCE = "debt"
_DEBT_VALID_DAYS = 100 * 365
#: Ledger notes of a reversal booked for a Stripe event start with the event
#: type; a clawback from ANOTHER lot starts with this, so it never counts as
#: that other lot's own refund/dispute.
CLAWBACK_NOTE = "clawback"


def _now() -> datetime:
    return datetime.now(UTC)


def satang_for_tokens(tokens: int) -> int:
    """What ``tokens`` cost from the balance — rounded UP to a whole satang."""
    if tokens <= 0:
        return 0
    return math.ceil(tokens * rate_card.TOPUP_SATANG_PER_1M / 1_000_000)


def tokens_for_satang(satang: int) -> int:
    """How many tokens ``satang`` buys — rounded DOWN (never over-grant)."""
    if satang <= 0:
        return 0
    return math.floor(satang * 1_000_000 / rate_card.TOPUP_SATANG_PER_1M)


async def balance(session: AsyncSession, user_id: int, now: datetime | None = None) -> int:
    """Σ remaining of the user's unexpired lots minus any debt (satang), never
    below zero."""
    at = now or _now()
    total = (
        await session.execute(
            select(func.coalesce(func.sum(WalletLot.remaining_satang), 0)).where(
                WalletLot.user_id == int(user_id),
                ((WalletLot.expires_at > at) & (WalletLot.remaining_satang > 0))
                | (WalletLot.remaining_satang < 0),
            )
        )
    ).scalar_one()
    return max(0, int(total or 0))


async def debt(session: AsyncSession, user_id: int) -> int:
    """Satang the user still owes from a chargeback/refund of spent baht."""
    owed = (
        await session.execute(
            select(func.coalesce(func.sum(WalletLot.remaining_satang), 0)).where(
                WalletLot.user_id == int(user_id), WalletLot.remaining_satang < 0
            )
        )
    ).scalar_one()
    return -int(owed or 0)


async def available(
    session: AsyncSession, account: UsageAccount, now: datetime | None = None
) -> int:
    """What a new run may still hold: balance minus open wallet holds."""
    return max(0, await balance(session, account.user_id, now) - int(account.wallet_reserved_satang or 0))


async def _refresh_cache(session: AsyncSession, account: UsageAccount, now: datetime) -> int:
    account.wallet_balance_satang = await balance(session, account.user_id, now)
    return int(account.wallet_balance_satang)


def _ledger(
    session: AsyncSession,
    *,
    user_id: int,
    kind: str,
    amount: int,
    balance_after: int,
    lot_id: int | None = None,
    run_id: str | None = None,
    note: str | None = None,
    actor_user_id: int | None = None,
) -> None:
    session.add(
        WalletLedger(
            user_id=int(user_id), lot_id=lot_id, run_id=run_id, kind=kind, amount_satang=int(amount),
            balance_after_satang=int(balance_after), note=(note or None) and note[:200],
            actor_user_id=actor_user_id,
        )
    )


async def credit(
    session: AsyncSession,
    user_id: int,
    amount_satang: int,
    *,
    source: str,
    now: datetime | None = None,
    stripe_session_id: str | None = None,
    payment_method: str | None = None,
    note: str | None = None,
    actor_user_id: int | None = None,
    kind: str = "purchase",
    expires_at: datetime | None = None,
    stripe_payment_intent: str | None = None,
) -> WalletLot | None:
    """Add a lot (valid 12 months). Returns None when ``stripe_session_id`` was
    already credited — a redelivered webhook is a no-op, not a second lot."""
    if amount_satang <= 0:
        raise ValueError("a credit must be positive")
    at = now or _now()
    account = await lock_account(session, user_id)
    values: dict[str, Any] = {
        "user_id": int(user_id),
        "source": source,
        "amount_satang": int(amount_satang),
        "remaining_satang": int(amount_satang),
        "expires_at": expires_at or at + timedelta(days=LOT_VALID_DAYS),
        "stripe_session_id": stripe_session_id,
        "stripe_payment_intent": stripe_payment_intent,
        "payment_method": payment_method,
        "created_at": at,
    }
    stmt = pg_insert(WalletLot).values(**values)
    if stripe_session_id:
        stmt = stmt.on_conflict_do_nothing(index_elements=["stripe_session_id"])
    lot_id = (await session.execute(stmt.returning(WalletLot.id))).scalar_one_or_none()
    if lot_id is None:
        log.info("wallet_credit_duplicate", user_id=user_id, stripe_session_id=stripe_session_id)
        return None
    after = await _refresh_cache(session, account, at)
    _ledger(
        session, user_id=user_id, kind=kind, amount=amount_satang, balance_after=after, lot_id=int(lot_id),
        note=note, actor_user_id=actor_user_id,
    )
    await session.flush()
    log.info("wallet_credited", user_id=user_id, satang=amount_satang, source=source)
    lot = await session.get(WalletLot, int(lot_id))
    assert lot is not None
    await _repay_debt(session, account, lot, at)
    return lot


async def _repay_debt(session: AsyncSession, account: UsageAccount, lot: WalletLot, at: datetime) -> None:
    """Pay outstanding debt (oldest first) out of a freshly credited lot."""
    debts = (
        await session.execute(
            select(WalletLot)
            .where(WalletLot.user_id == account.user_id, WalletLot.remaining_satang < 0)
            .order_by(WalletLot.id)
            .with_for_update()
        )
    ).scalars().all()
    for owed_lot in debts:
        pay = min(-int(owed_lot.remaining_satang), int(lot.remaining_satang))
        if pay <= 0:
            break
        owed_lot.remaining_satang = int(owed_lot.remaining_satang) + pay
        lot.remaining_satang = int(lot.remaining_satang) - pay
        await session.flush()
        _ledger(
            session, user_id=account.user_id, kind="debit", amount=-pay,
            balance_after=await balance(session, account.user_id, at), lot_id=int(lot.id),
            note=f"repays debt (lot {int(owed_lot.id)})",
        )
        log.warning("wallet_debt_repaid", user_id=account.user_id, satang=pay, debt_lot=int(owed_lot.id))
    await session.flush()
    await _refresh_cache(session, account, at)


async def debit(
    session: AsyncSession,
    account: UsageAccount,
    amount_satang: int,
    *,
    run_id: str | None = None,
    now: datetime | None = None,
    kind: str = "debit",
    note: str | None = None,
    actor_user_id: int | None = None,
) -> int:
    """Take up to ``amount_satang`` FIFO by expiry; returns what was taken.

    The caller holds ``account``'s lock. Never goes below zero: a shortfall is
    the caller's to handle (runs.py puts it on the windows instead).
    """
    if amount_satang <= 0:
        return 0
    at = now or _now()
    lots = (
        await session.execute(
            select(WalletLot)
            .where(
                WalletLot.user_id == account.user_id,
                WalletLot.expires_at > at,
                WalletLot.remaining_satang > 0,
            )
            .order_by(WalletLot.expires_at, WalletLot.id)
            .with_for_update()
        )
    ).scalars().all()
    remaining = int(amount_satang)
    taken_total = 0
    balance_now = sum(int(lot.remaining_satang) for lot in lots)
    for lot in lots:
        if remaining <= 0:
            break
        take = min(remaining, int(lot.remaining_satang))
        lot.remaining_satang = int(lot.remaining_satang) - take
        remaining -= take
        taken_total += take
        balance_now -= take
        _ledger(
            session, user_id=account.user_id, kind=kind, amount=-take, balance_after=balance_now,
            lot_id=int(lot.id), run_id=run_id, note=note, actor_user_id=actor_user_id,
        )
    await session.flush()
    await _refresh_cache(session, account, at)
    return taken_total


async def refund(
    session: AsyncSession,
    account: UsageAccount,
    run_id: str,
    *,
    now: datetime | None = None,
    note: str | None = None,
    actor_user_id: int | None = None,
) -> int:
    """Return every satang ``run_id`` took, to the lot it came from.

    A lot that has expired since gets a fresh ``refund`` lot with that lot's
    own expiry instead (so the refund does not extend the purchase's life —
    already-expired baht come back expired). Returns satang refunded.
    """
    at = now or _now()
    rows = (
        await session.execute(
            select(WalletLedger.lot_id, func.sum(WalletLedger.amount_satang))
            .where(
                WalletLedger.user_id == account.user_id,
                WalletLedger.run_id == run_id,
                WalletLedger.kind.in_(("debit", "refund")),
            )
            .group_by(WalletLedger.lot_id)
        )
    ).all()
    refunded = 0
    for lot_id, net in rows:
        owed = -int(net or 0)
        if owed <= 0 or lot_id is None:
            continue
        lot = await session.get(WalletLot, int(lot_id), with_for_update=True)
        if lot is None:
            continue
        lot.remaining_satang = int(lot.remaining_satang) + owed
        refunded += owed
        after = await balance(session, account.user_id, at)
        _ledger(
            session, user_id=account.user_id, kind="refund", amount=owed, balance_after=after,
            lot_id=int(lot.id), run_id=run_id, note=note, actor_user_id=actor_user_id,
        )
    await session.flush()
    await _refresh_cache(session, account, at)
    return refunded


async def adjust(
    session: AsyncSession,
    user_id: int,
    amount_satang: int,
    *,
    actor_user_id: int,
    note: str | None = None,
    now: datetime | None = None,
) -> int:
    """Admin credit (positive → new ``admin`` lot) or debit (negative, FIFO,
    never below zero). Returns the signed amount actually applied."""
    at = now or _now()
    if amount_satang > 0:
        await credit(
            session, user_id, amount_satang, source="admin", now=at, note=note,
            actor_user_id=actor_user_id, kind="adjust",
        )
        return amount_satang
    account = await lock_account(session, user_id)
    taken = await debit(
        session, account, -amount_satang, now=at, kind="adjust", note=note, actor_user_id=actor_user_id
    )
    return -taken


async def reverse_lot(
    session: AsyncSession,
    lot: WalletLot,
    owed_total_satang: int,
    *,
    note: str,
    now: datetime | None = None,
    category: str | None = None,
) -> tuple[int, int]:
    """Take a refunded / disputed top-up back out of ITS lot (not FIFO — the
    money that left Stripe is this purchase's).

    ``owed_total_satang`` is the cumulative amount the payer got back so far
    IN THIS ``category`` (the Stripe event type the ``note`` starts with:
    refunds are reported cumulatively, a dispute carries its own amount).
    What earlier reversals of the same category already took is subtracted,
    so a second partial refund takes only the difference — and a dispute
    after a partial refund is NOT reduced by that refund (it used to be: a
    ฿1,000 lot refunded ฿400 then disputed for the other ฿600 reversed only
    ฿200). Everything together never exceeds the lot's amount. Never below
    zero: baht already spent on runs cannot be taken back from the lot, and
    that part is returned as the shortfall for the caller. Returns
    ``(taken, shortfall)``.
    """
    at = now or _now()
    account = await lock_account(session, int(lot.user_id))
    lot = (
        await session.execute(
            select(WalletLot).where(WalletLot.id == lot.id).with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    async def _taken(prefix: str) -> int:
        return -int(
            (
                await session.execute(
                    select(func.coalesce(func.sum(WalletLedger.amount_satang), 0)).where(
                        WalletLedger.lot_id == lot.id,
                        WalletLedger.kind == "reversal",
                        WalletLedger.note.like(f"{prefix}%"),
                    )
                )
            ).scalar_one()
            or 0
        )

    # Only this lot's OWN reversals ("charge.…" notes) — a clawback taken from
    # it to cover another lot's shortfall is not its payer getting money back.
    already_total = await _taken("charge.")
    already = await _taken(category) if category else already_total
    owed = max(0, min(int(owed_total_satang) - already, int(lot.amount_satang) - already_total))
    take = min(owed, int(lot.remaining_satang))
    if take > 0:
        lot.remaining_satang = int(lot.remaining_satang) - take
        await session.flush()
        _ledger(
            session, user_id=int(lot.user_id), kind="reversal", amount=-take,
            balance_after=await balance(session, int(lot.user_id), at), lot_id=int(lot.id), note=note,
        )
    await session.flush()
    await _refresh_cache(session, account, at)
    return take, owed - take


async def clawback(
    session: AsyncSession, user_id: int, amount_satang: int, *, note: str, now: datetime | None = None
) -> tuple[int, int]:
    """Cover a reversal shortfall: take it from the user's OTHER live lots
    (FIFO), and carry what they cannot cover as debt. Returns
    ``(taken_from_other_lots, debt_recorded)``."""
    if amount_satang <= 0:
        return 0, 0
    at = now or _now()
    account = await lock_account(session, int(user_id))
    taken = await debit(
        session, account, amount_satang, now=at, kind="reversal", note=f"{CLAWBACK_NOTE}: {note}"[:200]
    )
    owed = int(amount_satang) - taken
    if owed > 0:
        session.add(
            WalletLot(
                user_id=int(user_id), source=DEBT_SOURCE, amount_satang=owed, remaining_satang=-owed,
                expires_at=at + timedelta(days=_DEBT_VALID_DAYS), created_at=at,
            )
        )
        await session.flush()
        await _refresh_cache(session, account, at)
        log.error("wallet_debt_recorded", user_id=int(user_id), satang=owed)
    return taken, owed


async def expire_due(session: AsyncSession, now: datetime | None = None) -> int:
    """Zero every lot past its expiry and write an ``expire`` ledger row each.
    Returns the number of lots expired. Daily worker cron."""
    at = now or _now()
    due = (
        await session.execute(
            select(WalletLot.user_id)
            .where(WalletLot.expires_at <= at, WalletLot.remaining_satang > 0)
            .distinct()
        )
    ).scalars().all()
    count = 0
    for user_id in due:
        account = await lock_account(session, int(user_id))
        lots = (
            await session.execute(
                select(WalletLot)
                .where(
                    WalletLot.user_id == int(user_id),
                    WalletLot.expires_at <= at,
                    WalletLot.remaining_satang > 0,
                )
                .with_for_update()
            )
        ).scalars().all()
        for lot in lots:
            lapsed = int(lot.remaining_satang)
            lot.remaining_satang = 0
            count += 1
            after = await balance(session, int(user_id), at)
            _ledger(
                session, user_id=int(user_id), kind="expire", amount=-lapsed, balance_after=after,
                lot_id=int(lot.id),
            )
        await _refresh_cache(session, account, at)
    await session.flush()
    if count:
        log.info("wallet_lots_expired", lots=count)
    return count


async def summary(session: AsyncSession, user_id: int, now: datetime | None = None) -> dict[str, Any]:
    """The ``GET /wallet/me`` body — baht (satang) only, never tokens."""
    at = now or _now()
    lots = (
        await session.execute(
            select(WalletLot)
            .where(WalletLot.user_id == int(user_id), WalletLot.expires_at > at, WalletLot.remaining_satang > 0)
            .order_by(WalletLot.expires_at, WalletLot.id)
        )
    ).scalars().all()
    history = (
        await session.execute(
            select(WalletLedger)
            .where(WalletLedger.user_id == int(user_id))
            .order_by(WalletLedger.id.desc())
            .limit(HISTORY_ROWS)
        )
    ).scalars().all()
    reserved = (
        await session.execute(
            select(UsageAccount.wallet_reserved_satang).where(UsageAccount.user_id == int(user_id))
        )
    ).scalar_one_or_none()
    return {
        "balance_satang": await balance(session, int(user_id), at),
        "reserved_satang": int(reserved or 0),
        "lots": [
            {"remaining_satang": int(lot.remaining_satang), "expires_at": _iso(lot.expires_at)} for lot in lots
        ],
        "history": [
            {"kind": h.kind, "amount_satang": int(h.amount_satang), "created_at": _iso(h.created_at)}
            for h in history
        ],
        "packs": list(PACKS_SATANG),
        "methods": list(METHODS),
    }


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
