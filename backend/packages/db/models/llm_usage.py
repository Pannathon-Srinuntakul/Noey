"""LLM usage log — core schema.

One row per vendor REQUEST made under a UsageCtx — every attempt that reached
the vendor, failed and retried ones included (``status``), because each one
costs us. Written by packages/billing/metering.py.

Two figures per row, kept apart on purpose:
- ``tokens`` — rate-card tokens (packages/billing/rate_card.py) at
  ``rate_version``: what the USER is charged. Fixed; FX never moves it.
- ``cost_thb`` — the real vendor cost at record time (admin price table ×
  ``fx_rate``): our margin. Null when the vendor reported no usage.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

CORE_SCHEMA = "core"


class LlmUsageLog(Base):
    __tablename__ = "llm_usage_logs"
    __table_args__ = (
        Index("ix_llm_usage_logs_user_id", "user_id"),
        Index("ix_llm_usage_logs_created_at", "created_at"),
        Index("ix_llm_usage_logs_feature", "feature"),
        Index("ix_llm_usage_logs_user_id_created_at", "user_id", "created_at"),
        Index("ix_llm_usage_logs_run_id", "run_id"),
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
    # chat | video | prompt_cron
    feature: Mapped[str] = mapped_column(String(32), nullable=False)
    # session_uid | project_uid | job_id — nullable for calls without a clear reference
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Part of ``input_tokens`` served from the vendor's context cache.
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    #: The paid run this request belongs to (null: legacy rows, scripts).
    run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey(f"{CORE_SCHEMA}.ai_runs.id", ondelete="SET NULL"), nullable=True
    )
    #: core.jobs.id at the time — reused per project, so run_id is the key.
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: ok | failed | retry (a failed attempt that was retried) | cancelled (cut
    #: off mid-flight by a worker restart / job timeout; input estimated)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ok", server_default="ok")
    tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    rate_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    cost_thb: Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(10, 4), nullable=True)
    #: Outbox idempotency: a row replayed from the Redis outbox is inserted once.
    idem_key: Mapped[str | None] = mapped_column(String(36), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
