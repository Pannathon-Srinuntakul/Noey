"""Single-use tokens sent by email — issue, consume, void.

The raw token (256 random bits, URL-safe) only ever exists in the email that
carries it; the database keeps its SHA-256. A token is valid while it is
unused and unexpired; consuming it and issuing a newer one of the same purpose
both set `used_at`, so at most one link per purpose works at any time.
"""

import hashlib
import secrets
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.auth_token import AuthToken

PURPOSE_VERIFY_EMAIL = "verify_email"
PURPOSE_RESET_PASSWORD = "reset_password"
PURPOSE_CHANGE_EMAIL = "change_email"

TTL: dict[str, timedelta] = {
    PURPOSE_VERIFY_EMAIL: timedelta(hours=48),
    PURPOSE_RESET_PASSWORD: timedelta(minutes=60),
    PURPOSE_CHANGE_EMAIL: timedelta(hours=24),
}

#: Longer input cannot be one of our tokens (43 characters); refusing it
#: early keeps garbage out of the hash lookup.
MAX_TOKEN_CHARS = 128


class InvalidToken(Exception):
    """Unknown, expired, already used or superseded — deliberately not told apart."""


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


async def void_tokens(session: AsyncSession, user_id: int, purpose: str) -> None:
    """Make every unused token of this purpose unusable."""
    await session.execute(
        update(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.used_at.is_(None),
        )
        .values(used_at=_now())
    )


async def issue_token(
    session: AsyncSession, user_id: int, purpose: str, *, new_email: str | None = None
) -> str:
    """A fresh raw token for ``purpose``; older unused ones of the same purpose
    are voided. Flushes, does not commit — commit BEFORE mailing the link."""
    if purpose not in TTL:
        raise ValueError(f"unknown token purpose: {purpose!r}")
    await void_tokens(session, user_id, purpose)
    raw = secrets.token_urlsafe(32)
    session.add(
        AuthToken(
            user_id=user_id,
            purpose=purpose,
            token_hash=hash_token(raw),
            new_email=new_email,
            expires_at=_now() + TTL[purpose],
        )
    )
    await session.flush()
    return raw


async def consume_token(session: AsyncSession, raw: str, purposes: Sequence[str]) -> AuthToken:
    """Mark the token used and return it, or raise ``InvalidToken``.

    The row is locked, so two concurrent uses of one link cannot both succeed.
    The caller commits (together with whatever the token authorises).
    """
    if not raw or len(raw) > MAX_TOKEN_CHARS:
        raise InvalidToken
    token = (
        await session.execute(
            select(AuthToken)
            .where(AuthToken.token_hash == hash_token(raw), AuthToken.purpose.in_(list(purposes)))
            .with_for_update()
        )
    ).scalar_one_or_none()
    now = _now()
    if token is None or token.used_at is not None or token.expires_at <= now:
        raise InvalidToken
    token.used_at = now
    await session.flush()
    return token
