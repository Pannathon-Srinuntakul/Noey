"""Admin login and sessions — deliberately separate from a normal login.

Flow (services/api/routers/admin.py):

1. password  → a remembered device skips straight to 3; otherwise an
   ``AdminLoginChallenge`` is created and a 6-digit code is emailed.
2. code      → consumed once, 5 wrong tries kill the challenge, 10-minute TTL.
3. session   → an ``AdminSession`` row + two JWTs with audience ``noey-admin``
   (typ ``admin_access`` / ``admin_refresh``) that carry its id as ``sid``.

A normal user token can never pass for an admin one: it has no audience (and
the admin decoder requires one) and a different ``type``; an admin token can
never pass for a user one because PyJWT refuses a token carrying an audience
the user decoder did not ask for. Every admin request re-reads the session row
and the user (is_admin, is_active, token_version) — claims are never trusted.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth.hashing import hash_password, verify_password
from packages.core.settings import get_settings
from packages.db.models.admin import (
    AdminAuditEvent,
    AdminDevice,
    AdminLoginChallenge,
    AdminSession,
)
from packages.db.models.core_auth import User

ADMIN_AUDIENCE = "noey-admin"
ACCESS_TYPE = "admin_access"
REFRESH_TYPE = "admin_refresh"

OTP_TTL = timedelta(minutes=10)
OTP_MAX_ATTEMPTS = 5
OTP_MAX_RESENDS = 3
OTP_DIGITS = 6

#: Failed password/code attempts for one address within the window that lock
#: it out (answered 429, whatever the password).
LOCKOUT_FAILURES = 5
LOCKOUT_WINDOW = timedelta(minutes=15)

#: How often the idle clock is written back — a busy dashboard must not turn
#: every read into a write.
_LAST_SEEN_WRITE_EVERY = timedelta(seconds=60)

UA_MAX = 255


def now() -> datetime:
    return datetime.now(UTC)


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def clip_ua(ua: str | None) -> str | None:
    return ua[:UA_MAX] if ua else None


# ── password check without an enumeration oracle ─────────────────────────────

_DUMMY_HASH: str | None = None


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
    return _DUMMY_HASH


def password_ok(user: User | None, password: str) -> bool:
    """bcrypt runs whether or not the account exists, so an unknown address
    takes as long as a wrong password."""
    hashed = str(user.password_hash) if user is not None else _dummy_hash()
    try:
        matched = verify_password(password, hashed)
    except ValueError:  # > 72 bytes: bcrypt refuses; a mismatch either way
        matched = False
    return matched and user is not None


# ── tokens ────────────────────────────────────────────────────────────────────

def encode_admin_token(kind: str, *, user_id: int, sid: str, tv: int, ttl_sec: int) -> str:
    s = get_settings()
    issued = now()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "sid": sid,
        "tv": int(tv),
        "typ": kind,
        "aud": ADMIN_AUDIENCE,
        "iat": issued,
        "exp": issued + timedelta(seconds=max(1, ttl_sec)),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_admin_token(token: str, kind: str) -> dict[str, Any]:
    """Validated payload of an admin token of ``kind``. Raises jwt.PyJWTError."""
    s = get_settings()
    payload = jwt.decode(
        token,
        s.jwt_secret,
        algorithms=[s.jwt_algorithm],
        audience=ADMIN_AUDIENCE,
        options={"require": ["exp", "iat", "sub", "sid", "aud", "typ"]},
    )
    if payload.get("typ") != kind:
        raise jwt.InvalidTokenError("wrong admin token type")
    return payload


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    access_expires_in: int


def issue_tokens(sess: AdminSession) -> IssuedTokens:
    s = get_settings()
    remaining = int((sess.expires_at - now()).total_seconds())
    access_ttl = max(1, min(s.admin_access_ttl, remaining))
    return IssuedTokens(
        access_token=encode_admin_token(
            ACCESS_TYPE, user_id=int(sess.user_id), sid=sess.id, tv=sess.token_version, ttl_sec=access_ttl
        ),
        refresh_token=encode_admin_token(
            REFRESH_TYPE, user_id=int(sess.user_id), sid=sess.id, tv=sess.token_version, ttl_sec=remaining
        ),
        access_expires_in=access_ttl,
    )


# ── audit ─────────────────────────────────────────────────────────────────────

async def audit(
    session: AsyncSession,
    action: str,
    *,
    actor_user_id: int | None = None,
    email: str | None = None,
    target_user_id: int | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    session.add(
        AdminAuditEvent(
            actor_user_id=actor_user_id,
            email=(email or "").strip().lower()[:255] or None,
            action=action,
            target_user_id=target_user_id,
            ip=(ip or "")[:64] or None,
            user_agent=clip_ua(user_agent),
            detail=detail,
        )
    )
    await session.flush()


async def recent_failures(session: AsyncSession, email: str) -> int:
    """Failed password + code attempts for this address in the lockout window."""
    since = now() - LOCKOUT_WINDOW
    found = await session.execute(
        select(func.count(AdminAuditEvent.id)).where(
            AdminAuditEvent.email == email.strip().lower(),
            AdminAuditEvent.action.in_(("login_failed", "login_otp_failed")),
            AdminAuditEvent.created_at >= since,
        )
    )
    return int(found.scalar() or 0)


# ── one-time codes ────────────────────────────────────────────────────────────

def new_code() -> str:
    return f"{secrets.randbelow(10**OTP_DIGITS):0{OTP_DIGITS}d}"


def code_hash(challenge_id: str, code: str) -> str:
    key = get_settings().jwt_secret.encode("utf-8")
    return hmac.new(key, f"{challenge_id}:{code}".encode(), hashlib.sha256).hexdigest()


async def create_challenge(session: AsyncSession, user: User, ip: str | None) -> tuple[AdminLoginChallenge, str]:
    """A fresh pending login for ``user``; any older open one is voided."""
    stamp = now()
    await session.execute(
        update(AdminLoginChallenge)
        .where(AdminLoginChallenge.user_id == user.id, AdminLoginChallenge.used_at.is_(None))
        .values(used_at=stamp)
    )
    challenge_id = secrets.token_urlsafe(32)
    code = new_code()
    challenge = AdminLoginChallenge(
        id=challenge_id,
        user_id=int(user.id),
        code_hash=code_hash(challenge_id, code),
        attempts=0,
        resends=0,
        expires_at=stamp + OTP_TTL,
        ip=(ip or "")[:64] or None,
    )
    session.add(challenge)
    await session.flush()
    return challenge, code


async def open_challenge(session: AsyncSession, challenge_id: str) -> AdminLoginChallenge | None:
    """The challenge if it is still usable (unused, unexpired, tries left), row-locked."""
    if not challenge_id or len(challenge_id) > 64:
        return None
    found = await session.execute(
        select(AdminLoginChallenge)
        .where(AdminLoginChallenge.id == challenge_id)
        .with_for_update()
    )
    challenge = found.scalar_one_or_none()
    if (
        challenge is None
        or challenge.used_at is not None
        or challenge.expires_at <= now()
        or challenge.attempts >= OTP_MAX_ATTEMPTS
    ):
        return None
    return challenge


def code_matches(challenge: AdminLoginChallenge, code: str) -> bool:
    candidate = code.strip()
    if len(candidate) != OTP_DIGITS or not candidate.isdigit():
        # Still compare, so a malformed code costs the same as a wrong one.
        candidate = "x" * OTP_DIGITS
    return hmac.compare_digest(challenge.code_hash, code_hash(challenge.id, candidate))


def rotate_code(challenge: AdminLoginChallenge) -> str:
    """Resend: a new code replaces the old one on the same pending login."""
    code = new_code()
    challenge.code_hash = code_hash(challenge.id, code)
    challenge.resends += 1
    challenge.expires_at = now() + OTP_TTL
    return code


# ── remembered devices ───────────────────────────────────────────────────────

async def remember_device(session: AsyncSession, user: User, user_agent: str | None) -> tuple[str, datetime]:
    raw = secrets.token_urlsafe(32)
    expires = now() + timedelta(days=get_settings().admin_device_ttl_days)
    session.add(
        AdminDevice(
            user_id=int(user.id),
            token_hash=_sha256(raw),
            token_version=int(user.token_version or 0),
            user_agent=clip_ua(user_agent),
            expires_at=expires,
        )
    )
    await session.flush()
    return raw, expires


async def valid_device(session: AsyncSession, user: User, raw: str | None) -> AdminDevice | None:
    """The remembered device behind ``raw`` — only for this user, unexpired,
    unrevoked and remembered under the user's current token version."""
    if not raw or len(raw) > 128:
        return None
    found = await session.execute(
        select(AdminDevice).where(AdminDevice.token_hash == _sha256(raw))
    )
    device = found.scalar_one_or_none()
    if (
        device is None
        or device.user_id != user.id
        or device.revoked_at is not None
        or device.expires_at <= now()
        or device.token_version != int(user.token_version or 0)
    ):
        return None
    return device


async def forget_device(session: AsyncSession, user_id: int, raw: str | None) -> None:
    if not raw or len(raw) > 128:
        return
    await session.execute(
        update(AdminDevice)
        .where(
            AdminDevice.token_hash == _sha256(raw),
            AdminDevice.user_id == user_id,
            AdminDevice.revoked_at.is_(None),
        )
        .values(revoked_at=now())
    )


# ── sessions ─────────────────────────────────────────────────────────────────

async def start_session(
    session: AsyncSession, user: User, ip: str | None, user_agent: str | None
) -> AdminSession:
    stamp = now()
    sess = AdminSession(
        id=secrets.token_urlsafe(32),
        user_id=int(user.id),
        token_version=int(user.token_version or 0),
        ip=(ip or "")[:64] or None,
        user_agent=clip_ua(user_agent),
        last_seen_at=stamp,
        expires_at=stamp + timedelta(seconds=get_settings().admin_session_max_sec),
    )
    session.add(sess)
    await session.flush()
    return sess


def session_alive(sess: AdminSession | None, user: User | None) -> bool:
    """Every condition an admin request must meet, re-read from the database."""
    if sess is None or user is None:
        return False
    stamp = now()
    idle = timedelta(seconds=get_settings().admin_idle_timeout_sec)
    return (
        sess.revoked_at is None
        and sess.expires_at > stamp
        and stamp - sess.last_seen_at <= idle
        and bool(user.is_active)
        and bool(user.is_admin)
        and sess.user_id == user.id
        and sess.token_version == int(user.token_version or 0)
    )


def touch(sess: AdminSession) -> None:
    stamp = now()
    if stamp - sess.last_seen_at >= _LAST_SEEN_WRITE_EVERY:
        sess.last_seen_at = stamp


async def revoke_sessions_and_devices(session: AsyncSession, user_id: int) -> None:
    """End every admin session and forget every device of this user."""
    stamp = now()
    await session.execute(
        update(AdminSession)
        .where(AdminSession.user_id == user_id, AdminSession.revoked_at.is_(None))
        .values(revoked_at=stamp)
    )
    await session.execute(
        update(AdminDevice)
        .where(AdminDevice.user_id == user_id, AdminDevice.revoked_at.is_(None))
        .values(revoked_at=stamp)
    )
