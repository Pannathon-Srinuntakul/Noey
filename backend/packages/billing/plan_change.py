"""Plan changes, independent of Stripe (docs/token-billing-plan.md §6).

Owner rules:

- UPGRADE takes effect immediately: ``users.plan`` moves now; the windows keep
  what was used, so the percentages simply drop under the bigger limits.
- DOWNGRADE takes effect at the next cycle: ``pending_plan`` is scheduled for
  the end of the paid period; until then the paid-for tier stays.
- CANCEL keeps the tier until the period ends, then Free (``pending_plan =
  "free"``). ``resume`` undoes a scheduled cancel / downgrade.
- PAYMENT FAILED gives a 3-day grace (``grace_until``); after it the account
  is Free until the payment recovers.

``apply_due`` (hourly worker cron) writes due changes to ``users.plan``;
until it runs, ``runs.effective_plan`` already reads a due change / lapsed
grace, so limits never lag behind the rule. ``enterprise`` (admin-granted) is
never touched.

``mirror_subscription`` is the one entry point the Stripe sync
(packages/billing/service.py) calls with what a subscription says; the
functions below are what any other payment provider would call.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import catalog
from packages.billing.accounts import lock_account
from packages.core.logging import get_logger
from packages.db.models.core_auth import User
from packages.db.models.usage_account import UsageAccount

log = get_logger(__name__)

GRACE = timedelta(days=3)
ENTERPRISE = "enterprise"


def _now() -> datetime:
    return datetime.now(UTC)


def rank(plan: str | None) -> int:
    """0 = free (or unknown), 1..N = the paid tiers in price order."""
    return catalog.tier_rank(plan)


async def _audit(session: AsyncSession, action: str, user: User, actor: dict[str, Any] | None, detail: dict) -> None:
    if not actor:
        return
    from packages.admin import auth as admin_auth

    await admin_auth.audit(
        session, action, actor_user_id=actor.get("user_id"), email=actor.get("email"),
        target_user_id=int(user.id), ip=actor.get("ip"), user_agent=actor.get("user_agent"), detail=detail,
    )


async def upgrade(
    session: AsyncSession, user: User, tier: str, *, actor: dict[str, Any] | None = None
) -> None:
    if user.plan == ENTERPRISE:
        return
    account = await lock_account(session, int(user.id))
    before = str(user.plan)
    user.plan = tier
    account.pending_plan = None
    account.pending_plan_at = None
    await session.flush()
    await _audit(session, "plan_upgrade", user, actor, {"before": before, "after": tier})
    log.info("plan_upgraded", user_id=int(user.id), before=before, after=tier)


async def schedule_downgrade(
    session: AsyncSession, user: User, tier: str, at: datetime, *, actor: dict[str, Any] | None = None
) -> None:
    if user.plan == ENTERPRISE:
        return
    account = await lock_account(session, int(user.id))
    account.pending_plan = tier
    account.pending_plan_at = at
    await session.flush()
    await _audit(session, "plan_downgrade_scheduled", user, actor, {"plan": tier, "at": at.isoformat()})
    log.info("plan_downgrade_scheduled", user_id=int(user.id), plan=tier, at=at.isoformat())


async def schedule_cancel(
    session: AsyncSession, user: User, at: datetime, *, actor: dict[str, Any] | None = None
) -> None:
    await schedule_downgrade(session, user, catalog.FREE_TIER, at, actor=actor)


async def resume(session: AsyncSession, user: User, *, actor: dict[str, Any] | None = None) -> None:
    account = await lock_account(session, int(user.id))
    had = account.pending_plan
    account.pending_plan = None
    account.pending_plan_at = None
    await session.flush()
    if had:
        await _audit(session, "plan_change_resumed", user, actor, {"dropped": had})


async def payment_failed(session: AsyncSession, user: User, now: datetime | None = None) -> datetime | None:
    """Start the 3-day grace (idempotent: a running grace is not extended)."""
    if user.plan == ENTERPRISE:
        return None
    at = now or _now()
    account = await lock_account(session, int(user.id))
    if account.grace_until is None:
        account.grace_until = at + GRACE
        await session.flush()
        log.info("plan_payment_grace_started", user_id=int(user.id), until=account.grace_until.isoformat())
    return account.grace_until


async def payment_recovered(session: AsyncSession, user: User) -> None:
    account = await lock_account(session, int(user.id))
    if account.grace_until is not None:
        account.grace_until = None
        await session.flush()
        log.info("plan_payment_recovered", user_id=int(user.id))


async def apply_due(session: AsyncSession, now: datetime | None = None) -> int:
    """Write every due scheduled change and lapsed grace to ``users.plan``.
    Returns how many accounts changed. Hourly worker cron."""
    at = now or _now()
    due = (
        await session.execute(
            select(UsageAccount.user_id).where(
                ((UsageAccount.pending_plan.is_not(None)) & (UsageAccount.pending_plan_at <= at))
                | ((UsageAccount.grace_until.is_not(None)) & (UsageAccount.grace_until <= at))
            )
        )
    ).scalars().all()
    changed = 0
    for user_id in due:
        account = await lock_account(session, int(user_id))
        user = await session.get(User, int(user_id), with_for_update=True)
        if user is None or user.plan == ENTERPRISE:
            continue
        before = str(user.plan)
        if account.grace_until is not None and account.grace_until <= at:
            # Grace stays set: the next sync that sees a paid invoice clears it
            # (payment_recovered) and the webhook upgrades back.
            user.plan = catalog.FREE_TIER
            account.pending_plan = None
            account.pending_plan_at = None
        elif account.pending_plan and account.pending_plan_at is not None and account.pending_plan_at <= at:
            user.plan = account.pending_plan
            account.pending_plan = None
            account.pending_plan_at = None
        if user.plan != before:
            changed += 1
            log.info("plan_change_applied", user_id=int(user_id), before=before, after=user.plan)
    await session.flush()
    return changed


async def mirror_subscription(
    session: AsyncSession,
    user: User,
    target: str,
    *,
    status: str | None,
    period_end: datetime | None,
    ending: bool,
    now: datetime | None = None,
) -> None:
    """Apply what a payment provider's subscription says, by the owner's rules.

    ``target`` — the tier the subscription is for (``free`` when there is no
    live one); ``ending`` — scheduled to cancel at period end.
    """
    if user.plan == ENTERPRISE:
        return
    at = now or _now()
    current = str(user.plan or catalog.FREE_TIER)
    account = await lock_account(session, int(user.id))

    if status == "past_due":
        until = await payment_failed(session, user, at)
        if until is not None and until <= at:
            if current != catalog.FREE_TIER:
                user.plan = catalog.FREE_TIER
                log.info("plan_grace_lapsed", user_id=int(user.id), before=current)
            return
    elif status in catalog.LIVE_STATUSES:
        await payment_recovered(session, user)
    else:
        # Not live (canceled / unpaid / paused / none): the provider already
        # waited out the paid period, so Free applies now.
        account.grace_until = None

    if target == catalog.FREE_TIER and status not in catalog.LIVE_STATUSES:
        account.pending_plan = None
        account.pending_plan_at = None
        if current != catalog.FREE_TIER:
            user.plan = catalog.FREE_TIER
            log.info("plan_ended", user_id=int(user.id), before=current)
        await session.flush()
        return

    if rank(target) > rank(current):
        await upgrade(session, user, target)
    elif rank(target) < rank(current):
        if period_end is not None and period_end > at:
            await schedule_downgrade(session, user, target, period_end)
        else:
            user.plan = target
            account.pending_plan = None
            account.pending_plan_at = None
    elif account.pending_plan and account.pending_plan != catalog.FREE_TIER and not ending:
        # Same tier as now, but a downgrade was scheduled and the provider
        # moved back: nothing is pending any more.
        await resume(session, user)

    if ending and period_end is not None and period_end > at:
        await schedule_cancel(session, user, period_end)
    elif not ending and account.pending_plan == catalog.FREE_TIER:
        await resume(session, user)
    await session.flush()
