"""Core-schema models behind the admin dashboard (admin/ app, routers/admin.py).

Admin access is a separate, stricter session from a normal login: password,
then an emailed one-time code, then an ``admin_sessions`` row that every admin
request re-checks. A "remembered device" only ever skips the code, never the
password. Everything an admin does — every login attempt and every write — is
appended to ``admin_audit_events``.

Secrets are never stored raw: OTP codes are HMAC-SHA256'd, device tokens and
session ids are looked up by their SHA-256.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class AdminLoginChallenge(Base):
    """A pending admin login: the password was right, the emailed code is awaited."""

    __tablename__ = "admin_login_challenges"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    #: Random, URL-safe; the pending-login id the code is bound to.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    #: HMAC-SHA256(JWT_SECRET, challenge id + code), hex.
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    resends: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: Set when consumed, when too many wrong codes were tried, or when a newer
    #: challenge for the same admin superseded it.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdminDevice(Base):
    """A browser that may skip the emailed code for 14 days (never the password)."""

    __tablename__ = "admin_devices"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    #: SHA-256 of the opaque device token, hex.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: users.token_version when the device was remembered: a password change,
    #: reset or deactivation bumps it and every device stops working.
    token_version: Mapped[int] = mapped_column(Integer)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdminSession(Base):
    """One signed-in admin browser. Every admin request re-checks this row."""

    __tablename__ = "admin_sessions"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    #: Random session id; the admin JWTs carry it as `sid`.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    token_version: Mapped[int] = mapped_column(Integer)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: Idle logout reads this: a session unused for ADMIN_IDLE_TIMEOUT_SEC is dead.
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: Absolute lifetime, however active the admin is.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdminAuditEvent(Base):
    """Append-only: every admin login attempt and every admin write."""

    __tablename__ = "admin_audit_events"
    __table_args__ = (
        Index("ix_admin_audit_events_created_at", "created_at"),
        Index("ix_admin_audit_events_action_email", "action", "email"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    #: The admin who acted — NULL for a failed login by an unknown address.
    actor_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    #: The address typed at login (normalized); the actor's for other events.
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: login_failed | login_otp_sent | login_otp_failed | login_success | logout |
    #: plan_change | quota_reset | account_activate | account_deactivate |
    #: price_change | cost_config_change
    action: Mapped[str] = mapped_column(String(40))
    target_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: before/after for writes; the (internal) failure reason for logins. Never
    #: a password, code or token.
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdminSetting(Base):
    """Owner-edited settings the dashboard computes with (e.g. `cost_config`)."""

    __tablename__ = "admin_settings"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB)
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PlanPriceOverride(Base):
    """The monthly price an admin set for a paid tier.

    With Stripe configured, Stripe stays the source of truth — an edit creates a
    new Stripe Price and this row only records it. Without Stripe, GET
    /billing/plans serves these amounts in place of the catalog's mock ones.
    """

    __tablename__ = "plan_price_overrides"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    tier: Mapped[str] = mapped_column(String(32), primary_key=True)
    #: satang (THB x 100), like Stripe.
    unit_amount: Mapped[int] = mapped_column(BigInteger)
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
