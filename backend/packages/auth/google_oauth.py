"""Sign in with Google: OAuth 2.0 authorization-code flow + OpenID Connect.

Written from Google's documentation as fetched on 2026-09-30:

- OpenID Connect (endpoints, auth-request parameters, ID-token claims and
  validation, "use `sub`, never `email`, as the identifier"):
  https://developers.google.com/identity/openid-connect/openid-connect
- OAuth 2.0 for web server apps (token exchange, exact-match redirect URIs,
  `state` against CSRF, callback errors such as `access_denied`):
  https://developers.google.com/identity/protocols/oauth2/web-server
- PKCE (`code_challenge` / `code_challenge_method=S256` / `code_verifier`,
  43–128 unreserved characters):
  https://developers.google.com/identity/protocols/oauth2/native-app
- Discovery document (issuer, endpoints, jwks_uri, RS256, S256 supported):
  https://accounts.google.com/.well-known/openid-configuration

The flow (services/api/routers/auth_google.py owns the HTTP side):

1. ``start_flow`` — a client names one of the server-side allow-listed
   redirect URIs (GOOGLE_REDIRECT_URIS; never trusted from the request) and an
   intent. We mint a PKCE verifier and a nonce, keep them server-side in a
   single-use flow record (Redis, 10 minutes), and hand back Google's
   authorization URL plus ``state``: a JWT signed with JWT_SECRET (own
   audience, 10-minute exp) that names the record. The verifier never leaves
   the server, so an intercepted ``code`` is useless on its own.
2. Google redirects the browser to the client's callback with ``code`` and
   ``state``. The client checks ``state`` equals the one it kept for this
   browser (login-CSRF binding), then posts both to the API.
3. ``finish_flow`` — verifies the state signature, SPENDS the flow record
   (a replayed state finds nothing), checks the redirect URI matches, exchanges
   the code (with the verifier) at Google's token endpoint, and verifies the
   returned ID token against Google's published keys: RS256 signature, ``iss``,
   ``aud`` = our client id, ``exp``/``iat``, and ``nonce`` = the one recorded.

Everything is OFF while GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
GOOGLE_REDIRECT_URIS are unset: ``google_config_problem`` names the missing
variable and the router answers 503 with it. Nothing here runs at import time.

Fail closed: the flow store refuses (``FlowStoreUnavailable``) when Redis
cannot answer — a sign-in whose state cannot be checked is refused, never
assumed.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol
from urllib.parse import urlencode

import httpx
import jwt
from redis.exceptions import RedisError

from packages.core.logging import get_logger
from packages.core.settings import Settings, get_settings

log = get_logger(__name__)

# ── Google's endpoints (discovery document, fetched 2026-09-30) ──────────────
AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"
#: "iss: Always https://accounts.google.com or accounts.google.com".
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
SCOPES = "openid email profile"

Intent = Literal["signin", "link", "reauth"]
INTENTS: tuple[str, ...] = ("signin", "link", "reauth")

#: How long a started sign-in may take before its state is refused.
FLOW_TTL_SEC = 10 * 60
STATE_AUDIENCE = "noey-google-state"
_HTTP_TIMEOUT_SEC = 10.0
#: Keys are re-fetched at most this often when an unknown `kid` shows up
#: (Google rotates keys; a token signed with a new key must still verify).
_JWKS_MIN_REFRESH_SEC = 60
_JWKS_DEFAULT_MAX_AGE_SEC = 3600
#: Allowed clock skew on exp/iat.
_LEEWAY_SEC = 60

#: Tests swap this for an ``httpx.MockTransport`` — the fake Google.
_transport: httpx.AsyncBaseTransport | None = None


class GoogleOAuthError(Exception):
    """The flow failed; ``code`` is stable for clients, ``detail`` is for logs."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


class FlowStoreUnavailable(Exception):
    """Redis could not answer; refuse the sign-in."""


# ── configuration ─────────────────────────────────────────────────────────────

def google_config_problem(settings: Settings | None = None) -> str | None:
    """Why Sign in with Google cannot run here, or None. Names the variable, never a value."""
    s = settings or get_settings()
    missing = [
        name
        for name, value in (
            ("GOOGLE_CLIENT_ID", s.google_client_id),
            ("GOOGLE_CLIENT_SECRET", s.google_client_secret),
        )
        if not (value or "").strip()
    ]
    if not s.google_redirect_uri_set:
        missing.append("GOOGLE_REDIRECT_URIS")
    if missing:
        return (
            "Sign in with Google is not configured on this server ("
            + ", ".join(missing)
            + (" is" if len(missing) == 1 else " are")
            + " not set)"
        )
    return None


def google_enabled(settings: Settings | None = None) -> bool:
    return google_config_problem(settings) is None


def redirect_uri_allowed(uri: str, settings: Settings | None = None) -> bool:
    """Exact match against the server-side allow-list (what Google compares too)."""
    s = settings or get_settings()
    return uri in s.google_redirect_uri_set


# ── PKCE / nonce ──────────────────────────────────────────────────────────────

_VERIFIER_RE = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")


def new_code_verifier() -> str:
    """64 URL-safe characters (384 random bits) — inside PKCE's 43–128 rule."""
    verifier = secrets.token_urlsafe(48)
    assert _VERIFIER_RE.match(verifier)
    return verifier


def code_challenge(verifier: str) -> str:
    """S256: base64url (no padding) of SHA-256(verifier)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


# ── the single-use flow record ────────────────────────────────────────────────

FLOW_PREFIX = "noey:oauth:google:"


class FlowStore(Protocol):
    async def put(self, sid: str, record: dict[str, Any], ttl_sec: int) -> None: ...

    async def take(self, sid: str) -> dict[str, Any] | None:
        """Return AND delete the record (atomic): a state works once."""
        ...


_redis_client: Any | None = None
_redis_loop: Any | None = None


def _redis() -> Any:
    """Per event loop, like packages/auth/refresh_store.py (same reason)."""
    global _redis_client, _redis_loop
    loop = asyncio.get_running_loop()
    if _redis_client is None or _redis_loop is not loop:
        import redis.asyncio as aioredis

        _redis_client = aioredis.from_url(
            get_settings().redis_url, socket_timeout=1.0, socket_connect_timeout=1.0
        )
        _redis_loop = loop
    return _redis_client


class RedisFlowStore:
    async def put(self, sid: str, record: dict[str, Any], ttl_sec: int) -> None:
        try:
            await _redis().set(FLOW_PREFIX + sid, json.dumps(record), ex=max(1, int(ttl_sec)))
        except (RedisError, OSError, TimeoutError) as exc:
            log.warning("google_flow_store_unavailable", op="put", error=type(exc).__name__)
            raise FlowStoreUnavailable("put") from exc

    async def take(self, sid: str) -> dict[str, Any] | None:
        try:
            raw = await _redis().getdel(FLOW_PREFIX + sid)
        except (RedisError, OSError, TimeoutError) as exc:
            log.warning("google_flow_store_unavailable", op="take", error=type(exc).__name__)
            raise FlowStoreUnavailable("take") from exc
        if raw is None:
            return None
        try:
            found = json.loads(raw)
        except ValueError:
            return None
        return found if isinstance(found, dict) else None


class MemoryFlowStore:
    """Tests only (per process)."""

    def __init__(self) -> None:
        self.records: dict[str, tuple[float, dict[str, Any]]] = {}

    async def put(self, sid: str, record: dict[str, Any], ttl_sec: int) -> None:
        self.records[sid] = (time.monotonic() + max(1, int(ttl_sec)), dict(record))

    async def take(self, sid: str) -> dict[str, Any] | None:
        found = self.records.pop(sid, None)
        if found is None or found[0] <= time.monotonic():
            return None
        return found[1]


_store: FlowStore | None = None


def get_flow_store() -> FlowStore:
    global _store
    if _store is None:
        _store = RedisFlowStore()
    return _store


# ── state (signed, expiring) ──────────────────────────────────────────────────

def _encode_state(sid: str, intent: str, settings: Settings) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sid": sid,
            "int": intent,
            "aud": STATE_AUDIENCE,
            "iat": now,
            "exp": now + timedelta(seconds=FLOW_TTL_SEC),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def _decode_state(state: str, settings: Settings) -> dict[str, Any]:
    try:
        return jwt.decode(
            state,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            audience=STATE_AUDIENCE,
            options={"require": ["sid", "int", "aud", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        raise GoogleOAuthError("invalid_state", type(exc).__name__) from None


# ── start ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StartedFlow:
    authorization_url: str
    state: str
    expires_in: int


async def start_flow(
    *,
    redirect_uri: str,
    intent: Intent,
    user_id: int | None = None,
    captcha_ok: bool = False,
    login_hint: str | None = None,
    settings: Settings | None = None,
) -> StartedFlow:
    """Record a new flow and build Google's authorization URL.

    The caller has already checked configuration and the allow-list; both are
    re-checked here so no path can skip them.
    """
    s = settings or get_settings()
    problem = google_config_problem(s)
    if problem:
        raise GoogleOAuthError("not_configured", problem)
    if not redirect_uri_allowed(redirect_uri, s):
        raise GoogleOAuthError("redirect_uri_not_allowed")
    if intent not in INTENTS:
        raise GoogleOAuthError("invalid_intent")

    sid = secrets.token_urlsafe(24)
    verifier = new_code_verifier()
    nonce = secrets.token_urlsafe(24)
    await get_flow_store().put(
        sid,
        {
            "verifier": verifier,
            "nonce": nonce,
            "redirect_uri": redirect_uri,
            "intent": intent,
            "user_id": user_id,
            "captcha_ok": bool(captcha_ok),
        },
        FLOW_TTL_SEC,
    )
    state = _encode_state(sid, intent, s)
    params: dict[str, str] = {
        "client_id": str(s.google_client_id).strip(),
        "response_type": "code",
        "scope": SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge(verifier),
        "code_challenge_method": "S256",
        # Only an ID token is needed: no offline access, no refresh token.
        "access_type": "online",
    }
    if intent == "signin":
        params["prompt"] = "select_account"
    else:
        # link / reauth are confirmations of a sensitive action: make the
        # person actively pick the account and pass Google's screen again
        # rather than being waved through by an existing Google session.
        params["prompt"] = "select_account consent"
    if login_hint:
        params["login_hint"] = login_hint[:255]
    url = f"{AUTHORIZATION_ENDPOINT}?{urlencode(params)}"
    return StartedFlow(authorization_url=url, state=state, expires_in=FLOW_TTL_SEC)


# ── finish ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GoogleIdentity:
    """What we keep from a verified ID token."""

    sub: str
    email: str | None
    email_verified: bool
    name: str | None


@dataclass(frozen=True)
class FinishedFlow:
    intent: Intent
    user_id: int | None
    captcha_ok: bool
    identity: GoogleIdentity


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SEC, transport=_transport)


async def _exchange_code(code: str, verifier: str, redirect_uri: str, s: Settings) -> str:
    """POST the code to Google's token endpoint; the raw ID token."""
    data = {
        "code": code,
        "client_id": str(s.google_client_id).strip(),
        "client_secret": str(s.google_client_secret).strip(),
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }
    try:
        async with _client() as client:
            resp = await client.post(TOKEN_ENDPOINT, data=data)
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("google_token_unreachable", error=type(exc).__name__)
        raise GoogleOAuthError("provider_unavailable", type(exc).__name__) from None
    if resp.status_code != 200 or not isinstance(body, dict):
        # invalid_grant = expired / already used code, or a verifier mismatch.
        err = body.get("error") if isinstance(body, dict) else None
        log.info("google_token_refused", status=resp.status_code, error=err)
        raise GoogleOAuthError("code_rejected", str(err or resp.status_code))
    id_token = body.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise GoogleOAuthError("code_rejected", "no id_token in the token response")
    return id_token


# JWKS cache: {kid: PyJWK}, when fetched, how long it may be kept.
_jwks: dict[str, jwt.PyJWK] = {}
_jwks_fetched_at = 0.0
_jwks_max_age = float(_JWKS_DEFAULT_MAX_AGE_SEC)
_jwks_lock: asyncio.Lock | None = None
_jwks_lock_loop: Any | None = None


def _lock() -> asyncio.Lock:
    global _jwks_lock, _jwks_lock_loop
    loop = asyncio.get_running_loop()
    if _jwks_lock is None or _jwks_lock_loop is not loop:
        _jwks_lock = asyncio.Lock()
        _jwks_lock_loop = loop
    return _jwks_lock


def reset_jwks_cache() -> None:
    global _jwks, _jwks_fetched_at, _jwks_max_age
    _jwks = {}
    _jwks_fetched_at = 0.0
    _jwks_max_age = float(_JWKS_DEFAULT_MAX_AGE_SEC)


def _max_age(cache_control: str | None) -> float:
    match = re.search(r"max-age=(\d+)", cache_control or "")
    return float(match.group(1)) if match else float(_JWKS_DEFAULT_MAX_AGE_SEC)


async def _fetch_jwks() -> None:
    global _jwks, _jwks_fetched_at, _jwks_max_age
    try:
        async with _client() as client:
            resp = await client.get(JWKS_URI)
        resp.raise_for_status()
        keyset = jwt.PyJWKSet.from_dict(resp.json())
    except (httpx.HTTPError, ValueError, jwt.PyJWTError) as exc:
        log.warning("google_jwks_unreachable", error=type(exc).__name__)
        raise GoogleOAuthError("provider_unavailable", "jwks") from None
    _jwks = {k.key_id: k for k in keyset.keys if k.key_id}
    _jwks_fetched_at = time.monotonic()
    _jwks_max_age = _max_age(resp.headers.get("cache-control"))


async def _signing_key(kid: str) -> jwt.PyJWK:
    async with _lock():
        age = time.monotonic() - _jwks_fetched_at
        stale = not _jwks or age > _jwks_max_age
        if stale or (kid not in _jwks and age > _JWKS_MIN_REFRESH_SEC):
            await _fetch_jwks()
        key = _jwks.get(kid)
    if key is None:
        raise GoogleOAuthError("invalid_id_token", "unknown signing key")
    return key


async def verify_id_token(id_token: str, *, nonce: str, settings: Settings | None = None) -> GoogleIdentity:
    """Verify signature, iss, aud, exp/iat and nonce; return the identity.

    ``email_verified`` is reported, not enforced here — whether an unverified
    Google email may be used is an account-linking decision (the router).
    """
    s = settings or get_settings()
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError:
        raise GoogleOAuthError("invalid_id_token", "malformed") from None
    if header.get("alg") != "RS256":
        raise GoogleOAuthError("invalid_id_token", "unexpected alg")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise GoogleOAuthError("invalid_id_token", "no kid")
    key = await _signing_key(kid)
    try:
        claims: dict[str, Any] = jwt.decode(
            id_token,
            key.key,
            algorithms=["RS256"],
            audience=str(s.google_client_id).strip(),
            leeway=_LEEWAY_SEC,
            options={"require": ["iss", "aud", "sub", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        raise GoogleOAuthError("invalid_id_token", type(exc).__name__) from None
    if claims.get("iss") not in ISSUERS:
        raise GoogleOAuthError("invalid_id_token", "issuer")
    got_nonce = claims.get("nonce")
    if not isinstance(got_nonce, str) or not hmac.compare_digest(got_nonce, nonce):
        raise GoogleOAuthError("invalid_id_token", "nonce")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > 255:
        raise GoogleOAuthError("invalid_id_token", "sub")
    email = claims.get("email")
    verified = claims.get("email_verified")
    name = claims.get("name")
    return GoogleIdentity(
        sub=sub,
        email=email.strip().lower() if isinstance(email, str) and email.strip() else None,
        # Documented as a boolean; accept the string form some libraries emit.
        email_verified=verified is True or verified == "true",
        name=name.strip()[:80] if isinstance(name, str) and name.strip() else None,
    )


async def finish_flow(
    *, code: str, state: str, redirect_uri: str, settings: Settings | None = None
) -> FinishedFlow:
    """Spend the flow named by ``state`` and return the verified Google identity."""
    s = settings or get_settings()
    problem = google_config_problem(s)
    if problem:
        raise GoogleOAuthError("not_configured", problem)
    claims = _decode_state(state, s)
    sid, intent = str(claims["sid"]), str(claims["int"])
    record = await get_flow_store().take(sid)
    if record is None:
        # Expired, already used, or never issued — not told apart.
        raise GoogleOAuthError("invalid_state", "no flow record")
    if record.get("intent") != intent or intent not in INTENTS:
        raise GoogleOAuthError("invalid_state", "intent mismatch")
    recorded_uri = str(record.get("redirect_uri") or "")
    if not hmac.compare_digest(recorded_uri, redirect_uri) or not redirect_uri_allowed(redirect_uri, s):
        raise GoogleOAuthError("redirect_uri_mismatch")
    id_token = await _exchange_code(code, str(record["verifier"]), redirect_uri, s)
    identity = await verify_id_token(id_token, nonce=str(record["nonce"]), settings=s)
    raw_uid = record.get("user_id")
    return FinishedFlow(
        intent=intent,  # type: ignore[arg-type]
        user_id=int(raw_uid) if isinstance(raw_uid, int) else None,
        captcha_ok=bool(record.get("captcha_ok")),
        identity=identity,
    )
