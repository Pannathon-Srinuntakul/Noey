"""Core-schema models: auth + tenant registry + background-job status.

These live in the Alembic-managed ``core`` schema (NOT per-tenant). Tenant business data
(custom tables, analytics) lives in ``tenant_<slug>`` schemas — see ``packages/db/tenancy.py``.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

CORE_SCHEMA = "core"
PLAN_VALUES = ("free", "starter", "pro", "enterprise")


class Tenant(Base):
    __tablename__ = "tenants"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(63), unique=True)  # → schema "tenant_<slug>"
    name: Mapped[str] = mapped_column(String(128))
    # Encrypted (Fernet) AI config: provider/model/base_url/api_key/prompt settings.
    ai_config: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class User(Base):
    __tablename__ = "users"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # Subscription plan — limits monthly token usage (see packages/llm/usage.py)
    plan: Mapped[str] = mapped_column(String(32), default="free", server_default="free")
    # Manual reset point set by admin; NULL means auto-reset at start of calendar month
    usage_reset_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "tenant_id", name="uq_memberships_user_id_tenant_id"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey(f"{CORE_SCHEMA}.tenants.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(32), default="owner")  # owner|admin|member
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Job(Base):
    """Background-job status (arq). Polled by the frontend for progress."""

    __tablename__ = "jobs"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # arq job id
    tenant_id: Mapped[int] = mapped_column(
        ForeignKey(f"{CORE_SCHEMA}.tenants.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(32))  # csv_export|csv_import|ai|summary_rebuild
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|ok|error
    progress: Mapped[int] = mapped_column(BigInteger, default=0)  # 0-100
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
