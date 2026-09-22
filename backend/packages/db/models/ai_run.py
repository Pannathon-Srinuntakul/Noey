"""One paid AI run — core schema.

``core.jobs.id`` cannot identify a run: the local-render routes reuse one id
per project (``vlocal_<uid[:8]>``) for every run on it. A run gets its own
row here instead, holding the reservation made at start, the estimate it was
made from and the actual cost the usage rows added up to, so the admin can
compare estimate vs actual per job (docs/token-billing-design.md §3.3).

Usage rows point back with ``run_id``; ``metering`` adds each recorded row's
rate-card tokens to ``actual_tokens`` in the same transaction. The reservation
/ settle behaviour is packages/billing/runs.py.
"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class AiRun(Base):
    __tablename__ = "ai_runs"
    __table_args__ = (
        Index("ix_ai_runs_user_id_status", "user_id", "status"),
        Index("ix_ai_runs_created_at", "created_at"),
        {"schema": CORE_SCHEMA},
    )

    #: uuid4 hex — the ``run_id`` passed to the worker and stored on usage rows.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.tenants.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: Project or style uid.
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: analyze_video | analyze_frames | transcribe_audio | plan_dub | reedit |
    #: plan_effects | distill_style | server_pipeline | voiceover
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    engine: Mapped[str | None] = mapped_column(String(32), nullable=True)
    precision: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: Seconds of footage/audio the estimate was computed from.
    media_sec: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")

    estimate_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: Part of the estimate held against the plan windows.
    reserved_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: Part held against the top-up balance.
    reserved_wallet_satang: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    #: ceil(estimate × 1.2) — the per-call guard stops the run past this.
    ceiling_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    #: Σ rate-card tokens of this run's usage rows (accrued as they are recorded).
    actual_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    charged_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    charged_wallet_satang: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    #: queued → running → settled | stopped | refunded | cancelled | released
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", server_default="queued")
    #: ok | limit_stop | our_failure | user_cancel | user_error | orphaned
    outcome: Mapped[str | None] = mapped_column(String(48), nullable=True)
    #: Admin/internal account: nothing held, nothing charged, still recorded.
    unlimited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    estimator_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    rate_version: Mapped[str | None] = mapped_column(String(16), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Concurrency-slot heartbeat; a lapsed lease frees the slot.
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
