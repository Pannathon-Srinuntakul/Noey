"""Single-use tokens mailed to a user: verify email, reset password, change email.

Only the SHA-256 of a token is stored — the raw value exists in the email and
nowhere else, so a database leak cannot be replayed. See
packages/auth/email_tokens.py for issuing and consuming.
"""

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA

TOKEN_PURPOSES = ("verify_email", "reset_password", "change_email")


class AuthToken(Base):
    __tablename__ = "auth_tokens"
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('verify_email', 'reset_password', 'change_email')", name="purpose"
        ),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    purpose: Mapped[str] = mapped_column(String(32))
    # hex SHA-256 of the raw token.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # change_email only: the address the account moves to once confirmed.
    new_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Set when the token is consumed — or superseded: issuing a new token
    # voids the user's older unused tokens of the same purpose.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
