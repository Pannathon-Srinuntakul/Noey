"""OAuth 2.1 authorization server for the blog MCP server (claude.ai custom connectors).

Verified against the MCP authorization spec (2026-07-28) and Claude's connector
docs on 2026-10-01 — see docs/blog-mcp.md for the facts and links. In short:

- Discovery: RFC 9728 Protected Resource Metadata (resource = `<API>/mcp`) and
  RFC 8414 Authorization Server Metadata (issuer = the API origin).
- Registration: Dynamic Client Registration (RFC 7591). Redirect URIs are
  allow-listed: Claude's hosted callback (`https://claude.ai/api/mcp/auth_callback`,
  and the `claude.com` one Anthropic says may replace it); loopback only when
  BLOG_MCP_ALLOW_LOOPBACK_REDIRECTS is on.
- Authorization code + PKCE S256 (mandatory — the SDK handler refuses anything
  else and checks the verifier), RFC 8707 `resource` bound into the grant and
  the token, RFC 9207 `iss` on the redirect back.
- Consent is the ADMIN dashboard: /authorize parks the request and sends the
  browser to `<ADMIN_URL>/connect?request=<id>`, where only a live admin session
  (password + emailed code) can approve it. An ordinary Noey Studio user has
  no way to approve anything.
- Tokens: short-lived access JWT (aud `noey-blog-mcp`, scope `blog:write`,
  `resource` claim) and a refresh JWT that is single-use — rotated through the
  same refresh store as user logins (packages/auth/refresh_store.py, own key
  prefix), and a replayed refresh token revokes the whole grant.
- Every token is checked against its `blog_oauth_grants` row and the admin
  account on every request: revoking in the admin, demoting or deactivating
  the admin, or changing their password ends access on the next call.

A user access token (aud `noey-app`) or admin token (`noey-admin`) fails the
audience check here; these tokens fail theirs (packages/auth/tokens.py refuses
any foreign `aud`, the admin decoder demands `noey-admin`).
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import jwt
from cryptography.fernet import Fernet, InvalidToken
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth import refresh_store
from packages.blog import service
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.blog import BlogOAuthClient, BlogOAuthGrant, BlogOAuthRequest
from packages.db.models.core_auth import User
from packages.db.session import get_sessionmaker

log = get_logger(__name__)

AUDIENCE = "noey-blog-mcp"
SCOPE = "blog:write"
ACCESS_TYPE = "blog_mcp_access"
REFRESH_TYPE = "blog_mcp_refresh"

#: Claude's hosted-app callback, and the one its docs say may replace it.
CLAUDE_CALLBACKS = frozenset(
    {"https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"}
)
REQUEST_TTL = timedelta(minutes=10)
CODE_TTL = timedelta(minutes=5)
REFRESH_PREFIX = "noey:blogmcp:refresh:"
#: How often a grant's last_used_at is written back.
_TOUCH_EVERY = timedelta(minutes=1)


# ── settings-derived URLs ────────────────────────────────────────────────────


def issuer() -> str:
    return get_settings().api_public_url.rstrip("/")


def resource_url() -> str:
    return get_settings().blog_mcp_resource_url


def _same_resource(a: str | None, b: str) -> bool:
    if not a:
        return False
    pa, pb = urlsplit(a.strip()), urlsplit(b)
    return (
        pa.scheme.lower() == pb.scheme.lower()
        and pa.netloc.lower() == pb.netloc.lower()
        and pa.path.rstrip("/") == pb.path.rstrip("/")
        and not pa.query
        and not pa.fragment
    )


def redirect_allowed(uri: str) -> bool:
    if uri in CLAUDE_CALLBACKS:
        return True
    if not get_settings().blog_mcp_allow_loopback_redirects:
        return False
    parts = urlsplit(uri)
    return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1") and not parts.fragment


# ── storage helpers ──────────────────────────────────────────────────────────


def _fernet() -> Fernet:
    """Client secrets are encrypted with a key derived from JWT_SECRET: the
    token endpoint must compare the presented secret, so it cannot be hashed."""
    raw = hashlib.sha256(f"blog-mcp-client-secret:{get_settings().jwt_secret}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def _session() -> AsyncSession:
    s = get_sessionmaker()()
    await s.execute(text("SET search_path TO core, public"))
    return s


_store: refresh_store.RefreshStore | None = None


def get_store() -> refresh_store.RefreshStore:
    global _store
    if _store is None:
        _store = refresh_store.RedisRefreshStore(prefix=REFRESH_PREFIX)
    return _store


# ── tokens ───────────────────────────────────────────────────────────────────


def _encode(claims: dict[str, Any], ttl: int) -> tuple[str, int]:
    s = get_settings()
    now = int(time.time())
    exp = now + max(1, ttl)
    payload = {**claims, "iss": issuer(), "aud": AUDIENCE, "iat": now, "exp": exp}
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm), exp


def decode(token: str, kind: str) -> dict[str, Any]:
    """Validated claims of a blog MCP token of `kind`. Raises jwt.PyJWTError."""
    s = get_settings()
    claims = jwt.decode(
        token,
        s.jwt_secret,
        algorithms=[s.jwt_algorithm],
        audience=AUDIENCE,
        issuer=issuer(),
        options={"require": ["exp", "iat", "aud", "iss", "typ", "gid", "cid", "jti"]},
    )
    if claims.get("typ") != kind:
        raise jwt.InvalidTokenError("wrong token type")
    return claims


async def _issue(grant: BlogOAuthGrant) -> OAuthToken:
    s = get_settings()
    base = {"sub": str(grant.admin_user_id), "gid": int(grant.id), "cid": grant.client_id, "scope": grant.scopes,
            "resource": grant.resource, "tv": int(grant.token_version)}
    access, _ = _encode({**base, "typ": ACCESS_TYPE, "jti": secrets.token_urlsafe(12)}, s.blog_mcp_access_ttl_sec)
    jti = refresh_store_jti = secrets.token_urlsafe(16)
    refresh, _ = _encode({**base, "typ": REFRESH_TYPE, "jti": jti}, s.blog_mcp_refresh_ttl_sec)
    await get_store().issue(int(grant.id), refresh_store_jti, s.blog_mcp_refresh_ttl_sec)
    return OAuthToken(
        access_token=access,
        token_type="Bearer",
        expires_in=s.blog_mcp_access_ttl_sec,
        refresh_token=refresh,
        scope=grant.scopes,
    )


async def grant_alive(db: AsyncSession, grant_id: int, *, tv: int | None = None) -> BlogOAuthGrant | None:
    """The grant when it, its client and its admin are all still good."""
    row = (
        await db.execute(
            select(BlogOAuthGrant, BlogOAuthClient, User)
            .join(BlogOAuthClient, BlogOAuthClient.client_id == BlogOAuthGrant.client_id)
            .join(User, User.id == BlogOAuthGrant.admin_user_id)
            .where(BlogOAuthGrant.id == grant_id)
        )
    ).first()
    if row is None:
        return None
    grant, client, user = row
    if grant.revoked_at is not None or client.revoked_at is not None:
        return None
    current_tv = int(user.token_version or 0)
    if not user.is_admin or not user.is_active or getattr(user, "deleted_at", None) is not None:
        return None
    if grant.token_version != current_tv or (tv is not None and tv != current_tv):
        return None
    return grant


async def revoke_grant(db: AsyncSession, grant_id: int, reason: str, actor: str) -> bool:
    res = await db.execute(
        update(BlogOAuthGrant)
        .where(BlogOAuthGrant.id == grant_id, BlogOAuthGrant.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC), revoked_reason=reason)
    )
    changed = bool(res.rowcount)  # type: ignore[attr-defined]
    try:
        await get_store().revoke_all(grant_id)
    except refresh_store.RefreshStoreUnavailable:
        # The grant row is the authority: every token is re-checked against it.
        log.warning("blog_oauth_revoke_store_unavailable", grant_id=grant_id)
    await service.audit(db, actor, "oauth_revoke", None, True, {"grant_id": grant_id, "reason": reason, "changed": changed})
    return changed


# ── the SDK provider ─────────────────────────────────────────────────────────


class BlogOAuthProvider:
    """`OAuthAuthorizationServerProvider` + `TokenVerifier` for the SDK's handlers."""

    # -- clients --

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        if not client_id or len(client_id) > 64:
            return None
        async with await _session() as db:
            row = (await db.execute(select(BlogOAuthClient).where(BlogOAuthClient.client_id == client_id))).scalar_one_or_none()
        if row is None or row.revoked_at is not None:
            return None
        secret = None
        if row.secret_enc:
            try:
                secret = _fernet().decrypt(row.secret_enc.encode()).decode()
            except InvalidToken:
                # JWT_SECRET rotated: the client must register again.
                return None
        return OAuthClientInformationFull.model_validate({**row.info, "client_secret": secret})

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        uris = [str(u) for u in (client_info.redirect_uris or [])]
        bad = [u for u in uris if not redirect_allowed(u)]
        if not uris or bad:
            async with await _session() as db:
                await service.audit(db, "oauth", "oauth_register", None, False, {"redirect_uris": uris, "client_name": client_info.client_name})
                await db.commit()
            raise RegistrationError(
                "invalid_redirect_uri",
                "Only Claude's connector callback (https://claude.ai/api/mcp/auth_callback) may be registered.",
            )
        scope = client_info.scope or SCOPE
        if set(scope.split()) - {SCOPE}:
            raise RegistrationError("invalid_client_metadata", f"The only scope is `{SCOPE}`.")
        info = client_info.model_dump(mode="json", exclude={"client_secret"})
        info["scope"] = SCOPE
        async with await _session() as db:
            db.add(
                BlogOAuthClient(
                    client_id=client_info.client_id,
                    client_name=(client_info.client_name or "")[:200] or None,
                    info=info,
                    secret_enc=_fernet().encrypt(client_info.client_secret.encode()).decode() if client_info.client_secret else None,
                )
            )
            await service.audit(
                db, f"mcp:{client_info.client_id}", "oauth_register", None, True,
                {"client_name": client_info.client_name, "redirect_uris": uris, "auth_method": client_info.token_endpoint_auth_method},
            )
            await db.commit()

    # -- authorization --

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource is not None and not _same_resource(params.resource, resource_url()):
            raise AuthorizeError("invalid_target", f"This server only issues tokens for {resource_url()}.")
        scopes = params.scopes or [SCOPE]
        if set(scopes) - {SCOPE}:
            raise AuthorizeError("invalid_scope", f"The only scope is `{SCOPE}`.")
        request_id = secrets.token_urlsafe(32)
        async with await _session() as db:
            db.add(
                BlogOAuthRequest(
                    id=request_id,
                    client_id=client.client_id,
                    params={
                        "state": params.state,
                        "scopes": [SCOPE],
                        "code_challenge": params.code_challenge,
                        "redirect_uri": str(params.redirect_uri),
                        "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
                        "resource": resource_url(),
                    },
                    expires_at=datetime.now(UTC) + REQUEST_TTL,
                )
            )
            await service.audit(db, f"mcp:{client.client_id}", "oauth_authorize", None, True, {"request": request_id[:8]})
            await db.commit()
        return f"{get_settings().admin_url.rstrip('/')}/connect?request={request_id}"

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        async with await _session() as db:
            req = (
                await db.execute(select(BlogOAuthRequest).where(BlogOAuthRequest.code_hash == _sha256(authorization_code)))
            ).scalar_one_or_none()
            if req is None or req.client_id != client.client_id or req.code_expires_at is None:
                return None
            if req.code_used_at is not None:
                # A code presented twice: OAuth 2.1 §4.1.3 — revoke what it issued.
                if req.grant_id is not None:
                    await revoke_grant(db, int(req.grant_id), "code_reuse", "oauth")
                    await db.commit()
                return None
            p = req.params
            return AuthorizationCode(
                code=authorization_code,
                scopes=list(p.get("scopes") or [SCOPE]),
                expires_at=req.code_expires_at.timestamp(),
                client_id=req.client_id,
                code_challenge=p["code_challenge"],
                redirect_uri=p["redirect_uri"],
                redirect_uri_provided_explicitly=bool(p.get("redirect_uri_provided_explicitly")),
                resource=p.get("resource"),
                subject=str(req.admin_user_id),
            )

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        async with await _session() as db:
            # Spend the code atomically: two racing exchanges cannot both win.
            res = await db.execute(
                update(BlogOAuthRequest)
                .where(
                    BlogOAuthRequest.code_hash == _sha256(authorization_code.code),
                    BlogOAuthRequest.code_used_at.is_(None),
                )
                .values(code_used_at=datetime.now(UTC))
                .returning(BlogOAuthRequest.grant_id)
            )
            grant_id = res.scalar_one_or_none()
            grant = await grant_alive(db, int(grant_id)) if grant_id is not None else None
            if grant is None:
                await db.commit()
                raise TokenError("invalid_grant", "authorization code is no longer valid")
            tokens = await _issue(grant)
            await service.audit(db, f"mcp:{client.client_id}", "oauth_token", None, True, {"grant_id": grant.id, "grant": "authorization_code"})
            await db.commit()
            return tokens

    # -- refresh (single use; reuse revokes the grant) --

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        try:
            claims = decode(refresh_token, REFRESH_TYPE)
        except jwt.PyJWTError:
            return None
        if claims["cid"] != client.client_id:
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=claims["cid"],
            scopes=str(claims.get("scope") or SCOPE).split(),
            expires_at=int(claims["exp"]),
            resource=claims.get("resource"),
            subject=str(claims.get("sub")),
        )

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        claims = decode(refresh_token.token, REFRESH_TYPE)
        gid = int(claims["gid"])
        remaining = max(1, int(claims["exp"]) - int(time.time()))
        try:
            outcome = await get_store().consume(gid, str(claims["jti"]), remaining)
        except refresh_store.RefreshStoreUnavailable:
            raise TokenError("invalid_request", "temporarily unavailable, retry shortly") from None
        async with await _session() as db:
            if outcome is refresh_store.Consume.REUSED:
                await revoke_grant(db, gid, "refresh_reuse", "oauth")
                await db.commit()
                raise TokenError("invalid_grant", "refresh token was already used; the connection was revoked")
            if outcome is not refresh_store.Consume.SPENT:
                raise TokenError("invalid_grant", "refresh token is not valid")
            grant = await grant_alive(db, gid, tv=claims.get("tv"))
            if grant is None:
                raise TokenError("invalid_grant", "the connection was revoked")
            tokens = await _issue(grant)
            await service.audit(db, f"mcp:{client.client_id}", "oauth_token", None, True, {"grant_id": gid, "grant": "refresh_token"})
            await db.commit()
            return tokens

    # -- resource server --

    async def load_access_token(self, token: str) -> AccessToken | None:
        try:
            claims = decode(token, ACCESS_TYPE)
        except jwt.PyJWTError:
            return None
        tv = claims.get("tv")
        if isinstance(tv, bool) or not isinstance(tv, int):
            return None
        async with await _session() as db:
            grant = await grant_alive(db, int(claims["gid"]), tv=tv)
            if grant is None:
                return None
            now = datetime.now(UTC)
            if grant.last_used_at is None or now - grant.last_used_at >= _TOUCH_EVERY:
                grant.last_used_at = now
                await db.commit()
        return AccessToken(
            token=token,
            client_id=str(claims["cid"]),
            scopes=str(claims.get("scope") or "").split(),
            expires_at=int(claims["exp"]),
            resource=claims.get("resource"),
            subject=str(claims.get("sub")),
            claims={"iss": claims["iss"], "gid": int(claims["gid"])},
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        return await self.load_access_token(token)

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        """RFC 7009: revoking either token ends the whole grant."""
        try:
            claims = jwt.decode(token.token, options={"verify_signature": False})
            gid = int(claims["gid"])
        except (jwt.PyJWTError, KeyError, TypeError, ValueError):
            return
        async with await _session() as db:
            await revoke_grant(db, gid, "client_revoke", f"mcp:{token.client_id}")
            await db.commit()

    async def exchange_identity_assertion(self, client: Any, params: Any) -> OAuthToken:
        raise TokenError("unsupported_grant_type", "not supported")


# ── the admin side of consent ────────────────────────────────────────────────


class ConsentError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        self.status = status
        self.detail = detail
        super().__init__(detail)


async def pending_request(db: AsyncSession, request_id: str) -> tuple[BlogOAuthRequest, BlogOAuthClient]:
    if not request_id or len(request_id) > 64:
        raise ConsentError(404, "ไม่พบคำขอเชื่อมต่อนี้")
    row = (
        await db.execute(
            select(BlogOAuthRequest, BlogOAuthClient)
            .join(BlogOAuthClient, BlogOAuthClient.client_id == BlogOAuthRequest.client_id)
            .where(BlogOAuthRequest.id == request_id)
            .with_for_update(of=BlogOAuthRequest)
        )
    ).first()
    if row is None:
        raise ConsentError(404, "ไม่พบคำขอเชื่อมต่อนี้")
    req, client = row
    if req.decision is not None:
        raise ConsentError(409, "คำขอนี้ถูกตัดสินไปแล้ว — เริ่มเชื่อมต่อใหม่จากหน้าตั้งค่าตัวเชื่อมต่อ")
    if req.expires_at <= datetime.now(UTC):
        raise ConsentError(410, "คำขอหมดอายุแล้ว (10 นาที) — เริ่มเชื่อมต่อใหม่อีกครั้ง")
    if client.revoked_at is not None:
        raise ConsentError(410, "ตัวเชื่อมต่อนี้ถูกยกเลิกแล้ว")
    return req, client


def describe_request(req: BlogOAuthRequest, client: BlogOAuthClient) -> dict[str, Any]:
    redirect = str(req.params.get("redirect_uri", ""))
    host = urlsplit(redirect).hostname or ""
    return {
        "request_id": req.id,
        "client_id": client.client_id,
        "client_name": client.client_name or "ไม่ระบุชื่อ",
        "redirect_uri": redirect,
        "redirect_host": host,
        "loopback": host in ("localhost", "127.0.0.1"),
        "scopes": list(req.params.get("scopes") or [SCOPE]),
        "resource": req.params.get("resource"),
        "expires_at": service.iso(req.expires_at),
    }


async def approve(db: AsyncSession, request_id: str, admin_user: User) -> str:
    req, client = await pending_request(db, request_id)
    now = datetime.now(UTC)
    grant = BlogOAuthGrant(
        client_id=client.client_id,
        admin_user_id=int(admin_user.id),
        token_version=int(admin_user.token_version or 0),
        scopes=" ".join(req.params.get("scopes") or [SCOPE]),
        resource=str(req.params.get("resource") or resource_url()),
    )
    db.add(grant)
    await db.flush()
    code = secrets.token_urlsafe(32)
    req.decision = "approved"
    req.decided_at = now
    req.admin_user_id = int(admin_user.id)
    req.code_hash = _sha256(code)
    req.code_expires_at = now + CODE_TTL
    req.grant_id = grant.id
    await service.audit(
        db, f"admin:{admin_user.id}", "oauth_approve", None, True,
        {"client_id": client.client_id, "client_name": client.client_name, "grant_id": grant.id},
    )
    return construct_redirect_uri(
        str(req.params["redirect_uri"]), code=code, state=req.params.get("state"), iss=issuer()
    )


async def deny(db: AsyncSession, request_id: str, admin_user: User) -> str:
    req, client = await pending_request(db, request_id)
    req.decision = "denied"
    req.decided_at = datetime.now(UTC)
    req.admin_user_id = int(admin_user.id)
    await service.audit(db, f"admin:{admin_user.id}", "oauth_deny", None, True, {"client_id": client.client_id})
    return construct_redirect_uri(
        str(req.params["redirect_uri"]),
        error="access_denied",
        error_description="The owner declined the connection.",
        state=req.params.get("state"),
        iss=issuer(),
    )


async def list_grants(db: AsyncSession) -> list[dict[str, Any]]:
    rows = await db.execute(
        select(BlogOAuthGrant, BlogOAuthClient, User.email)
        .join(BlogOAuthClient, BlogOAuthClient.client_id == BlogOAuthGrant.client_id)
        .join(User, User.id == BlogOAuthGrant.admin_user_id)
        .order_by(BlogOAuthGrant.revoked_at.is_not(None), BlogOAuthGrant.created_at.desc())
        .limit(100)
    )
    return [
        {
            "grant_id": int(g.id),
            "client_id": c.client_id,
            "client_name": c.client_name or "ไม่ระบุชื่อ",
            "redirect_hosts": sorted({urlsplit(str(u)).hostname or "" for u in (c.info.get("redirect_uris") or [])}),
            "approved_by": email,
            "scopes": g.scopes,
            "created_at": service.iso(g.created_at),
            "last_used_at": service.iso(g.last_used_at),
            "revoked_at": service.iso(g.revoked_at),
            "revoked_reason": g.revoked_reason,
            "active": g.revoked_at is None,
        }
        for g, c, email in rows.all()
    ]
