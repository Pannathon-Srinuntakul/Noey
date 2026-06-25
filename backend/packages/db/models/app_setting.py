from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class AppSetting(Base):
    """Single-row user-editable config (id=1). NULL fields fall back to env defaults.

    API keys are intentionally NOT stored here — they live in env only.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    scrape_interval: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    market_scrape_interval: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    llm_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    llm_base_url: Mapped[str | None] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
