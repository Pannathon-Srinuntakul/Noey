"""JWT access + refresh token helpers.

Both carry `tv` — the user's `token_version` when the token was issued.
Verification (services/api/deps.py, POST /auth/refresh) rejects a token whose
`tv` differs from the current `users.token_version`, so bumping it (password
change or reset) revokes every token issued before. A token without `tv`
(issued before revocation shipped) counts as version 0.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from packages.core.settings import get_settings


def _settings():
    return get_settings()


def _now() -> datetime:
    return datetime.now(UTC)


def encode_access(user_id: int, tenant_id: int, tenant_slug: str, token_version: int = 0) -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "tslug": tenant_slug,
        "tv": int(token_version),
        "type": "access",
        "exp": _now() + timedelta(seconds=s.jwt_access_ttl),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def encode_refresh(user_id: int, tenant_id: int, token_version: int = 0) -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "tv": int(token_version),
        "type": "refresh",
        "exp": _now() + timedelta(seconds=s.jwt_refresh_ttl),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode(token: str) -> dict[str, Any]:
    """Decode + validate JWT. Raises jwt.PyJWTError on any failure."""
    s = _settings()
    return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])


def token_version_matches(payload: dict[str, Any], current: int | None) -> bool:
    """Whether a decoded token belongs to the user's current token version.

    A missing claim is version 0; a malformed one never matches.
    """
    raw = payload.get("tv", 0)
    if isinstance(raw, bool) or not isinstance(raw, int):
        return False
    return raw == int(current or 0)
