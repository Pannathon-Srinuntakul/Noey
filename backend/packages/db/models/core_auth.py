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
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base

CORE_SCHEMA = "core"
# lite/starter/pro/studio/agency/max are the self-service paid tiers
# (packages/billing/catalog.py maps each to its Stripe price); `enterprise` is
# admin-only. Not a DB constraint — `users.plan` is a plain string column.
PLAN_VALUES = ("free", "lite", "starter", "pro", "studio", "agency", "max", "enterprise")


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
    # What the person wants to be called. NULL = never set (the UI falls back
    # to the email). Set at self-service registration or via PATCH /auth/me.
    display_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # When the person proved they own `email` (verification link, password
    # reset, or a confirmed email change). NULL = not verified yet. Accounts
    # that existed before verification shipped were backfilled as verified.
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Every JWT carries this as its `tv` claim; bumping it (password change or
    # reset) invalidates every token issued before. Tokens without `tv` count
    # as 0, which is why the column starts at 0.
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # Subscription plan — its limits are packages/billing/limits.py; the
    # rolling-window state is core.usage_accounts (packages/billing/runs.py).
    plan: Mapped[str] = mapped_column(String(32), default="free", server_default="free")
    # When an admin last reset this account's windows (audit convenience; the
    # windows themselves live in core.usage_accounts). Kept until the admin app
    # stops reading it — nothing enforces from it any more.
    usage_reset_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Free-tier abuse limits (packages/billing/free_tier.py): salted hashes of
    # the sign-up IP and the client's device id — never the raw values.
    signup_ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    signup_device_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
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
