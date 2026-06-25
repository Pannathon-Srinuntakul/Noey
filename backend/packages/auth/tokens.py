"""JWT access + refresh token helpers."""

from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from packages.core.settings import get_settings


def _settings():
    return get_settings()


def _now() -> datetime:
    return datetime.now(UTC)


def encode_access(user_id: int, tenant_id: int, tenant_slug: str) -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "tslug": tenant_slug,
        "type": "access",
        "exp": _now() + timedelta(seconds=s.jwt_access_ttl),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def encode_refresh(user_id: int, tenant_id: int) -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "type": "refresh",
        "exp": _now() + timedelta(seconds=s.jwt_refresh_ttl),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode(token: str) -> dict[str, Any]:
    """Decode + validate JWT. Raises jwt.PyJWTError on any failure."""
    s = _settings()
    return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
