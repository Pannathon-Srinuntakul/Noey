"""Per-user billing state — core schema. One row per user, created lazily.

The row is the LOCK target for everything that moves a user's money or
limits: a reservation at job start, the settle at job end, a wallet debit,
an admin window reset and a plan change all take ``SELECT … FOR UPDATE`` on
it first, so parallel jobs of one user can never both spend the same
headroom (docs/token-billing-design.md §6.1).

Windows are ROLLING and start at first use: a window is active while
``now < <window>_started_at + length``; an inactive window reads as unused
and restarts at the next reservation (packages/billing/runs.py).
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
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
    monthly_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    monthly_used: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")

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
