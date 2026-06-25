from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class SalesDaily(Base):
    """One daily snapshot row per (date, product, creator). Idempotent upsert target."""

    __tablename__ = "sales_daily"
    __table_args__ = (
        UniqueConstraint("snapshot_date", "product_id", "creator_id", name="sales_daily_natural"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    creator_id: Mapped[str] = mapped_column(ForeignKey("creators.id"), index=True)
    units: Mapped[int] = mapped_column(Integer, default=0)
    gmv: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0)
    commission: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
