"""One-off: take trial usage back out of paid windows it leaked into (2026-10-01).

The bug: every tracked window is charged alongside Free's lifetime credit, so a
user who spent 419k of the 450k trial and then subscribed to Lite inside the
same calendar month found the fresh month "52 % used". From 2026-10-01 an
upgrade restarts the paid windows (``plan_change.upgrade`` →
``runs.restart_paid_windows``); this script repairs the accounts that upgraded
BEFORE that fix.

For every paid account whose current monthly window started BEFORE its paid
subscription began, the monthly (and weekly) usage is recomputed from the
source of truth — the ``ai_runs`` the user was charged for since the
subscription started — so trial usage drops out and paid usage stays. The
trial credit's own record (``lifetime_used``) is never touched. Idempotent:
the numbers are recomputed from the runs each time, so a second run changes
nothing.

When the subscription began:
  * Stripe configured (STRIPE_SECRET_KEY): the live subscription's
    ``start_date`` (the moment the customer first subscribed);
  * otherwise ``--since USER_ID=2026-09-28T10:00:00Z`` per account (read it
    off the Stripe dashboard); an account without a date is listed and left
    alone.

Usage (from backend/, against the database in .env):
    python scripts/fix_trial_leak.py                  # dry run: what would change
    python scripts/fix_trial_leak.py --apply          # write it
    python scripts/fix_trial_leak.py --since 42=2026-09-28T10:00:00Z --apply
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text

from packages.billing import catalog, runs
from packages.billing.accounts import lock_account
from packages.db.models.ai_run import AiRun
from packages.db.models.core_auth import User
from packages.db.models.usage_account import UsageAccount
from packages.db.session import get_sessionmaker

PAID = tuple(p.tier for p in catalog.PAID_PLANS)


def _parse_since(values: list[str]) -> dict[int, datetime]:
    out: dict[int, datetime] = {}
    for value in values:
        uid, _, when = value.partition("=")
        out[int(uid)] = datetime.fromisoformat(when).astimezone(UTC)
    return out


async def _stripe_start(user_id: int, session: Any) -> datetime | None:
    """The live subscription's start_date, when Stripe is configured."""
    from packages.billing.client import billing_enabled, get_stripe_client
    from packages.billing.objects import field
    from packages.billing.service import _choose_subscription, fetch_subscriptions, get_account

    if not billing_enabled():
        return None
    account = await get_account(session, user_id)
    if account is None:
        return None
    client = get_stripe_client()
    sub = _choose_subscription(await fetch_subscriptions(client, account.stripe_customer_id),
                               account.stripe_customer_id)
    start = field(sub, "start_date") if sub is not None else None
    return datetime.fromtimestamp(start, tz=UTC) if isinstance(start, int) else None


async def _charged_since(session: Any, user_id: int, since: datetime) -> int:
    return int((await session.execute(
        select(func.coalesce(func.sum(AiRun.charged_tokens), 0)).where(
            AiRun.user_id == user_id, AiRun.created_at >= since, AiRun.unlimited.is_(False),
        )
    )).scalar_one() or 0)


async def main(apply: bool, since: dict[int, datetime]) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    report: list[dict[str, Any]] = []
    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        rows = (await session.execute(
            select(User.id, User.plan, User.email).join(UsageAccount, UsageAccount.user_id == User.id)
            .where(User.plan.in_(PAID), User.is_admin.is_(False))
        )).all()
        for user_id, plan, email in rows:
            account = await lock_account(session, int(user_id))
            started = account.monthly_started_at
            if started is None or not runs.window_active(started, "monthly", now, runs.anchor_day(account)):
                continue  # no live month to repair
            paid_since = since.get(int(user_id)) or await _stripe_start(int(user_id), session)
            row: dict[str, Any] = {
                "user_id": int(user_id), "email": email, "plan": plan,
                "monthly_started_at": runs.iso(started), "monthly_used": int(account.monthly_used or 0),
                "lifetime_used": int(account.lifetime_used or 0),
            }
            if paid_since is None:
                row["action"] = "needs --since (no subscription start known)"
                report.append(row)
                continue
            row["paid_since"] = runs.iso(paid_since)
            if paid_since <= started:
                row["action"] = "ok (the month began after the subscription)"
                report.append(row)
                continue
            monthly = await _charged_since(session, int(user_id), paid_since)
            weekly_start = account.weekly_started_at
            weekly = None
            if weekly_start is not None and runs.window_active(weekly_start, "weekly", now):
                weekly = await _charged_since(session, int(user_id), max(paid_since, weekly_start))
            row.update(new_monthly_used=monthly, new_weekly_used=weekly)
            changed = monthly != int(account.monthly_used or 0) or (
                weekly is not None and weekly != int(account.weekly_used or 0)
            )
            row["action"] = ("fixed" if apply else "would fix") if changed else "ok (already correct)"
            if apply and changed:
                account.monthly_used = monthly
                if weekly is not None:
                    account.weekly_used = weekly
            report.append(row)
        if apply:
            await session.commit()
        else:
            await session.rollback()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the fix (default: dry run)")
    parser.add_argument("--since", action="append", default=[], metavar="USER_ID=ISO",
                        help="when that account's paid subscription began (repeatable)")
    args = parser.parse_args()
    for line in asyncio.run(main(args.apply, _parse_since(args.since))):
        print(line)
