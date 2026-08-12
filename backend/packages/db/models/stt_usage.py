"""Speech-to-text usage log — core schema.

One row per transcription run, holding the audio length ElevenLabs billed for.

Why a local ledger rather than asking ElevenLabs: the API key is a **single
shared account** that every user of this system transcribes through, so its
account totals are everyone's usage added together. Reporting that to a user
would show them other people's consumption. Attribution has to happen here,
where the user who triggered the run is known.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

CORE_SCHEMA = "core"


class SttUsageLog(Base):
    __tablename__ = "stt_usage_logs"
    __table_args__ = (
        Index("ix_stt_usage_logs_user_id", "user_id"),
        Index("ix_stt_usage_logs_created_at", "created_at"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    tenant_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey(f"{CORE_SCHEMA}.tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    # project_uid — nullable for runs with no project (probes, scripts).
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # What ElevenLabs reported it processed (`audio_duration_secs`), summed
    # over the clips of one run. Seconds, because that is the unit Scribe
    # bills on.
    audio_sec: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # Seconds alone cannot be priced: scribe_v2_5 costs ~12.5× scribe_v2 per
    # second (measured 2026-08-12 — see packages/video/stt_pricing.py). Without
    # the model, a cost figure would be wrong by an order of magnitude the day
    # the setting changes.
    model: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
