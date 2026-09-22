"""Exchange rates and vendor invoices — core schema.

``fx_rates``: the daily USD→THB rate the usage recorder prices ``cost_thb``
with (fetched by the worker's ``refresh_fx`` cron, packages/billing/fx.py).
An admin override lives in ``admin_settings`` (``fx_override``) and always
wins over these rows.

``vendor_invoices``: what Google / ElevenLabs actually billed for a month,
typed in by the owner, so the admin can reconcile it against the sum of the
recorded ``cost_thb`` (docs/token-billing-plan.md §3.6).
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class FxRate(Base):
    __tablename__ = "fx_rates"
    __table_args__ = (
        UniqueConstraint("rate_date", "source", name="uq_fx_rates_rate_date_source"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    #: The UTC day the rate was fetched for.
    rate_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    usd_thb: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    #: open.er-api.com | frankfurter.app
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class VendorInvoice(Base):
    __tablename__ = "vendor_invoices"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    #: YYYY-MM
    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    #: gemini | elevenlabs
    vendor: Mapped[str] = mapped_column(String(16), primary_key=True)
    amount_thb: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
