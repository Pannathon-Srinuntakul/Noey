"""External sign-in identities linked to a user (Sign in with Google).

One row = one provider account proven to belong to one of our users. The
provider's stable subject id (`sub`) is the key an identity is found by —
never the email: Google documents that an account's email can change while
`sub` never does and is never reused (see packages/auth/google_oauth.py for
the documentation links).

A user has at most one identity per provider, and a provider identity belongs
to at most one user. Rows go with the user (ON DELETE CASCADE) and are deleted
outright by account deletion (packages/auth/account_deletion.py).
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA

PROVIDER_GOOGLE = "google"


class OAuthIdentity(Base):
    __tablename__ = "oauth_identities"
    __table_args__ = (
        UniqueConstraint("provider", "subject", name="uq_oauth_identities_provider_subject"),
        UniqueConstraint("user_id", "provider", name="uq_oauth_identities_user_id_provider"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    #: The provider's subject id (Google `sub`: up to 255 ASCII characters).
    subject: Mapped[str] = mapped_column(String(255))
    #: The provider's email when the link was made — informational only (shown
    #: in settings); never used to look the identity up.
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
