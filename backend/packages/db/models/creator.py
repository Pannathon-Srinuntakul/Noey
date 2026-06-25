from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class Creator(Base):
    __tablename__ = "creators"

    # TikTok creator id (string, natural PK).
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    handle: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
