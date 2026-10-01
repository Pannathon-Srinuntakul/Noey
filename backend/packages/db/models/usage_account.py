"""Per-user billing state — core schema. One row per user, created lazily.

The row is the LOCK target for everything that moves a user's money or
limits: a reservation at job start, the settle at job end, a wallet debit,
an admin window reset and a plan change all take ``SELECT … FOR UPDATE`` on
it first, so parallel jobs of one user can never both spend the same
headroom (docs/token-billing-design.md §6.1).

The ``monthly`` window — the one every paid plan enforces — is a CALENDAR
window: it runs from one billing anniversary to the next
(``monthly_anchor_day``), so the allowance refills on the day the
subscription renews rather than 30 days after the user's first cut. The
sub-windows nobody enforces (``five_hour``, ``weekly``) are still rolling:
active while ``now < <window>_started_at + length``. ``lifetime`` never runs
out. See packages/billing/runs.py for the arithmetic.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, SmallInteger, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class UsageAccount(Base):
    __tablename__ = "usage_accounts"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), primary_key=True
    )

    # Rate-card tokens charged in each window (settled runs only; open
    # reservations are in ``reserved_tokens``).
    five_hour_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    five_hour_used: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    weekly_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    weekly_used: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    # ``monthly`` is the calendar window: ``monthly_started_at`` is the START
    # of the current billing period (00:00 UTC on the anniversary), not the
    # moment of first use, and it lasts until the next anniversary.
    monthly_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    monthly_used: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: Day of month (1–31) the monthly allowance refills on, at 00:00 UTC.
    #: Written by the Stripe sync from the subscription's billing-cycle anchor
    #: (packages/billing/service.py) and, for an account that has no
    #: subscription at all — admin-granted, enterprise, a plan set by hand —
    #: pinned once to the day of its first charge. A month too short for the
    #: day falls back to its last day, the way Stripe does (31 → 28/29/30).
    #: Never cleared: a lapsed subscription keeps the day it used to renew on,
    #: so ending one cannot hand out an extra reset.
    monthly_anchor_day: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # The one window that never rolls: it starts at the account's first charge
    # and accumulates for as long as the account exists. Free spends its trial
    # credit against it (packages/billing/limits.py), and paid plans keep
    # charging it so a later downgrade to Free does not refill the credit.
    lifetime_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lifetime_used: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")

    #: Rate-card tokens charged PAST 100 % of the enforced window (owner,
    #: 2026-10-01: a call already in flight is charged in full, so a window
    #: can end at e.g. 106 %). The overage carries over: when that window
    #: starts its next period it starts AT this amount (106 % → 6 %), not 0.
    #: For Free (``lifetime``, never resets) it is applied to the first paid
    #: window after an upgrade, and simply kept — absorbed — if that never
    #: happens. A downgrade to Free drops it; it is never billed as money.
    #: A run allowed to use the top-up balance pays its overage from there
    #: instead, and nothing is carried. See packages/billing/runs.py.
    overage_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: The window ``overage_tokens`` was charged past (``monthly``/``lifetime``…).
    overage_window: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: The same carried excess for the ``weekly`` window, which Pro and up
    #: enforce BESIDE ``monthly`` (owner, 2026-10-01). Kept apart because one
    #: call can push both windows past 100 % at once, by different amounts,
    #: and each carries into its OWN next period: a weekly overage opens the
    #: next week (the month already counted it, so it is not carried there
    #: twice). ``overage_tokens`` stays the plan's main window (monthly /
    #: lifetime). Dropped when the plan no longer enforces a weekly window.
    weekly_overage_tokens: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )

    #: Σ open reservations held against the plan windows.
    reserved_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: Cache of Σ unexpired wallet lots (packages/billing/wallet.py keeps it).
    wallet_balance_satang: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    #: Σ open reservations held against the wallet.
    wallet_reserved_satang: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )

    #: A downgrade / cancel scheduled for the end of the paid period
    #: (packages/billing/plan_change.py).
    pending_plan: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pending_plan_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Payment failed: the paid plan holds until this moment, then Free.
    grace_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
