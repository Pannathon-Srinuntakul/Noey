"""LLM usage log — core schema.

One row per litellm.acompletion() call that had a UsageCtx set.
Used for per-user token accounting, cost estimation, and plan limit checks.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

CORE_SCHEMA = "core"


class LlmUsageLog(Base):
    __tablename__ = "llm_usage_logs"
    __table_args__ = (
        Index("ix_llm_usage_logs_user_id", "user_id"),
        Index("ix_llm_usage_logs_created_at", "created_at"),
        Index("ix_llm_usage_logs_feature", "feature"),
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
