"""JWT access + refresh token helpers.

Both carry `tv` — the user's `token_version` when the token was issued.
Verification (services/api/deps.py, POST /auth/refresh) rejects a token whose
`tv` differs from the current `users.token_version`, so bumping it (password
change or reset) revokes every token issued before. A token without `tv`
(issued before revocation shipped) counts as version 0.

Refresh tokens also carry `jti`: the id under which packages/auth/
refresh_store.py holds the token, so each one can be spent exactly once
(POST /auth/refresh) or dropped early (POST /auth/logout). A refresh token
without `jti` predates rotation; the router accepts it once (see there).

Both kinds carry `aud` = AUDIENCE, so a token minted for another audience
(the admin dashboard's `noey-admin`, packages/admin/auth.py) can never pass
as a user token even though both are signed with the same secret. A token
WITHOUT `aud` is still accepted — that is every token issued before the claim
existed (2026-09-27), and the last of those expires `jwt_refresh_ttl` (14 days)
after that deploy. Once those are gone the grace in `decode` can be removed:
a token that names a DIFFERENT audience is refused already.
"""

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from packages.core.settings import get_settings

#: The audience of every user (web/desktop) token. Admin tokens use their own.
AUDIENCE = "noey-app"

#: Claims every user token must carry. `jwt.decode` refuses a token missing
#: any of them, so the routers can index `payload["sub"]` without a KeyError
#: turning into a 500. `tv`, `aud` and `jti` are deliberately NOT here: each
#: has a documented default for tokens issued before it existed.
REQUIRED_CLAIMS: tuple[str, ...] = ("exp", "iat", "sub", "tid", "type")


def _settings():
    return get_settings()


def _now() -> datetime:
    return datetime.now(UTC)


def new_jti() -> str:
    """A fresh refresh-token id: 128 random bits, URL-safe."""
    return secrets.token_urlsafe(16)


def encode_access(user_id: int, tenant_id: int, tenant_slug: str, token_version: int = 0) -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "tslug": tenant_slug,
        "tv": int(token_version),
        "type": "access",
        "aud": AUDIENCE,
        "exp": _now() + timedelta(seconds=s.jwt_access_ttl),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def encode_refresh(
    user_id: int, tenant_id: int, token_version: int = 0, *, jti: str | None = None
) -> str:
    """A refresh token. Pass the `jti` the refresh store was given for it.

    `jti=None` mints the pre-rotation shape (no id). The API never does that;
    it exists for callers outside the request path (scripts/seed_loadtest.py)
    whose tokens the router then accepts under the one-time legacy rule.
    """
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tid": tenant_id,
        "tv": int(token_version),
        "type": "refresh",
        "aud": AUDIENCE,
        "exp": _now() + timedelta(seconds=s.jwt_refresh_ttl),
        "iat": _now(),
    }
    if jti is not None:
        payload["jti"] = jti
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode(token: str, *, verify_exp: bool = True) -> dict[str, Any]:
    """Decode + validate a user token. Raises jwt.PyJWTError on any failure.

    Audience is checked by hand rather than through `audience=`: PyJWT treats
    a token with no `aud` as a failure when an audience is expected, and the
    tokens issued before the claim existed must keep working until they expire
    (module docstring). `verify_exp=False` is for logout only — an expired
    refresh token is still the one the client wants forgotten.
    """
    s = _settings()
    payload: dict[str, Any] = jwt.decode(
        token,
        s.jwt_secret,
        algorithms=[s.jwt_algorithm],
        options={"require": list(REQUIRED_CLAIMS), "verify_aud": False, "verify_exp": verify_exp},
    )
    aud = payload.get("aud")
    if aud is not None and aud != AUDIENCE:
        raise jwt.InvalidAudienceError("Invalid audience")
    return payload


def token_version_matches(payload: dict[str, Any], current: int | None) -> bool:
    """Whether a decoded token belongs to the user's current token version.

    A missing claim is version 0; a malformed one never matches.
    """
    raw = payload.get("tv", 0)
    if isinstance(raw, bool) or not isinstance(raw, int):
        return False
    return raw == int(current or 0)


# ── re-authentication proof (account deletion for Google-only accounts) ─────

#: A short-lived proof that the person just passed a fresh Google sign-in for
#: THIS account (POST /auth/google/callback with intent "reauth"). It is not a
#: session token — its own audience means no route that takes an access token
#: accepts it, and `decode` above refuses it.
REAUTH_AUDIENCE = "noey-reauth"
REAUTH_TTL_SEC = 5 * 60


def encode_reauth(user_id: int, token_version: int, *, purpose: str = "delete_account") -> str:
    s = _settings()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "tv": int(token_version),
        "purpose": purpose,
        "aud": REAUTH_AUDIENCE,
        "exp": _now() + timedelta(seconds=REAUTH_TTL_SEC),
        "iat": _now(),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def reauth_matches(token: str, *, user_id: int, token_version: int, purpose: str = "delete_account") -> bool:
    """Whether ``token`` is a live re-auth proof for this user, version and purpose."""
    s = _settings()
    try:
        payload = jwt.decode(
            token,
            s.jwt_secret,
            algorithms=[s.jwt_algorithm],
            audience=REAUTH_AUDIENCE,
            options={"require": ["sub", "tv", "purpose", "aud", "exp", "iat"]},
        )
    except jwt.PyJWTError:
        return False
    return (
        str(payload.get("sub")) == str(user_id)
        and payload.get("purpose") == purpose
        and token_version_matches(payload, token_version)
    )
