from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Integer, Numeric, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class MarketTrend(Base):
    """External market-trend snapshot (trending products/creators beyond the owner)."""

    __tablename__ = "market_trends"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    entity_type: Mapped[str] = mapped_column(String(32))  # "product" | "creator"
    external_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metric: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
