"""Sign in with Google — another way to obtain the SAME tokens as /auth/login.

Protocol, documentation links and the security checks live in
packages/auth/google_oauth.py; this module is the HTTP side and the
account-linking policy. A Google sign-in ends in exactly what a password
sign-in ends in: a pair from `auth._tokens_for` (refresh token registered in
the refresh store, `tv` = the user's token_version). There is no second
session system.

    GET  /auth/google/config      → {enabled, redirect_uris}  (public)
    POST /auth/google/start       → {authorization_url, state, expires_in}
    POST /auth/google/callback    → depends on the intent the flow started with
    DELETE /auth/google           → unlink (only while a password exists)

Intents: "signin" (public), "link" and "reauth" (both need the caller's
ACCESS token on /start AND on /callback, and it must be the same user).

Account-linking policy (signin) — decided 2026-09-30, see `_signin`:

1. The Google `sub` is already linked → that account, nothing else consulted.
   Email is never used to find an identity again: Google says an account's
   email can change, `sub` never does.
2. Google says the email is NOT verified → refused. We would be trusting an
   address nobody proved they own, for linking or for a new account.
3. An account already uses the email (any capitalisation):
   - it is active, NOT an admin, has no other Google identity, and OUR side
     has verified the email too → linked automatically and signed in. Both
     sides then proved control of the same mailbox.
   - otherwise → refused (409 `link_requires_password`): the person signs in
     with their password and links from settings (intent "link"). Linking
     onto an account whose email WE never verified is the classic takeover:
     an attacker registers victim@gmail.com with a password first, the
     victim later "signs in with Google" and lands in the attacker's account
     (or the reverse, depending on which side auto-links).
     Admin accounts are never auto-linked: their privileges deserve the
     explicit, authenticated link step.
4. No account uses the email → a new free account exactly like
   /auth/register: ALLOW_REGISTRATION must be on (403 otherwise), the
   REGISTER_* rate limits apply, the Turnstile check applies when
   TURNSTILE_SECRET_KEY is set (the token is verified on /start — see
   there), the free-tier IP/device hashes are recorded. The email counts as
   verified (Google verified it — rule 2), and the account has no password
   until the person sets one through forgot-password.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from packages.auth import google_oauth
from packages.auth.accounts import UNUSABLE_PASSWORD_HASH, create_account, has_usable_password
from packages.auth.google_oauth import FlowStoreUnavailable, GoogleIdentity, GoogleOAuthError
from packages.auth.tokens import REAUTH_TTL_SEC, encode_reauth
from packages.auth.turnstile import TOKEN_MAX_CHARS, verify_turnstile
from packages.billing import free_tier
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.core_auth import User
from packages.db.models.oauth_identity import PROVIDER_GOOGLE, OAuthIdentity
from packages.email.message import mask_email
from services.api import ratelimit
from services.api.deps import AuthUser, CurrentUser, core_session, current_user
from services.api.routers.auth import TokenOut, _home_tenant, _tokens_for

log = get_logger(__name__)

router = APIRouter(prefix="/auth/google", tags=["auth"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]
_bearer = HTTPBearer(auto_error=False)

# ── client-facing messages (Thai; `code` is what a client branches on) ───────

_MSG = {
    "not_configured": "ยังไม่ได้เปิดใช้การเข้าสู่ระบบด้วย Google บนเซิร์ฟเวอร์นี้",
    "redirect_uri_not_allowed": "ที่อยู่สำหรับกลับจาก Google ไม่อยู่ในรายการที่อนุญาต",
    "invalid_state": "การเข้าสู่ระบบด้วย Google หมดเวลาหรือถูกใช้ไปแล้ว — กรุณาเริ่มใหม่อีกครั้ง",
    "redirect_uri_mismatch": "การเข้าสู่ระบบด้วย Google ไม่ตรงกับที่เริ่มไว้ — กรุณาเริ่มใหม่อีกครั้ง",
    "code_rejected": "Google ไม่ยอมรับคำขอนี้ (อาจหมดเวลา) — กรุณาเริ่มใหม่อีกครั้ง",
    "invalid_id_token": "ยืนยันตัวตนกับ Google ไม่สำเร็จ — กรุณาเริ่มใหม่อีกครั้ง",
    "provider_unavailable": "ติดต่อ Google ไม่ได้ในขณะนี้ — กรุณาลองใหม่อีกครั้งในอีกสักครู่",
    "store_unavailable": "ระบบเข้าสู่ระบบไม่พร้อมชั่วคราว — กรุณาลองใหม่อีกครั้งในอีกสักครู่",
    "email_not_verified": "อีเมลของบัญชี Google นี้ยังไม่ได้รับการยืนยัน จึงใช้เข้าสู่ระบบไม่ได้",
    "link_requires_password": (
        "มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว — กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน "
        "แล้วเชื่อมต่อบัญชี Google จากหน้าตั้งค่าบัญชี"
    ),
    "account_disabled": "บัญชีนี้ถูกปิดใช้งาน — กรุณาติดต่อผู้ดูแลระบบ",
    "registration_closed": "ยังไม่เปิดรับสมัครสมาชิกใหม่ในขณะนี้",
    "captcha_failed": "ยืนยันว่าไม่ใช่บอทไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง",
    "captcha_required": "กรุณายืนยันว่าไม่ใช่บอทก่อนสมัครด้วย Google",
    "google_in_use": "บัญชี Google นี้เชื่อมต่อกับบัญชีอื่นอยู่แล้ว",
    "already_linked": "บัญชีนี้เชื่อมต่อกับบัญชี Google อื่นอยู่แล้ว — กรุณายกเลิกการเชื่อมต่อเดิมก่อน",
    "wrong_account": "การยืนยันนี้เริ่มจากบัญชีอื่น — กรุณาเริ่มใหม่จากบัญชีที่เข้าสู่ระบบอยู่",
    "not_linked_google": "บัญชี Google ที่เลือกไม่ได้เชื่อมต่อกับบัญชีนี้",
    "no_google_link": "บัญชีนี้ไม่ได้เชื่อมต่อกับ Google",
    "password_required": "กรุณาตั้งรหัสผ่านก่อนยกเลิกการเชื่อมต่อ Google (ใช้ “ลืมรหัสผ่าน”) ไม่อย่างนั้นจะเข้าสู่ระบบไม่ได้อีก",
    "try_again": "เกิดการทำรายการซ้อนกัน — กรุณาลองใหม่อีกครั้ง",
    "no_tenant": "บัญชีนี้ยังไม่พร้อมใช้งาน — กรุณาติดต่อผู้ดูแลระบบ",
}

_STATUS = {
    "not_configured": 503,
    "redirect_uri_not_allowed": 400,
    "invalid_state": 400,
    "redirect_uri_mismatch": 400,
    "code_rejected": 400,
    "invalid_id_token": 401,
    "provider_unavailable": 502,
    "invalid_intent": 422,
}


#: Linking needs the account's OWN address proven first. Anyone can register an
#: address they do not own; a Google link made on such an account survived the
#: real owner's password reset and let the squatter sign straight back in.
_LINK_NEEDS_VERIFIED_MSG = "ยืนยันอีเมลของบัญชีก่อน จึงจะเชื่อมบัญชี Google ได้"


def _require_verified_for_link(auth: AuthUser) -> None:
    if auth.user.email_verified_at is None:
        raise _refuse(403, "email_not_verified", _LINK_NEEDS_VERIFIED_MSG)


def _refuse(status_code: int, code: str, message: str | None = None) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"code": code, "message": message or _MSG.get(code, code)}
    )


def _from_flow_error(exc: GoogleOAuthError) -> HTTPException:
    if exc.code == "not_configured":
        # The variable names are for the owner reading the response or log.
        return _refuse(503, "not_configured", f"{_MSG['not_configured']} ({exc.detail})")
    log.info("google_flow_refused", code=exc.code, detail=exc.detail)
    return _refuse(_STATUS.get(exc.code, 400), exc.code)


def _require_configured() -> None:
    problem = google_oauth.google_config_problem()
    if problem:
        raise _refuse(503, "not_configured", f"{_MSG['not_configured']} ({problem})")


async def _caller(
    request: Request, creds: HTTPAuthorizationCredentials | None, session: AsyncSession
) -> AuthUser:
    """The access-token user (401 like every authenticated route)."""
    return await current_user(request, creds, session)


# ── schemas ───────────────────────────────────────────────────────────────────

class ConfigOut(BaseModel):
    enabled: bool
    #: The allow-listed callback URLs (public anyway: Google shows them).
    redirect_uris: list[str]


class StartIn(BaseModel):
    #: Must equal one of GOOGLE_REDIRECT_URIS exactly.
    redirect_uri: str = Field(min_length=1, max_length=2048)
    intent: Literal["signin", "link", "reauth"] = "signin"
    #: Turnstile token from the sign-in page (signin only). Needed for a
    #: Google sign-in to CREATE an account while TURNSTILE_SECRET_KEY is set.
    turnstile_token: str | None = Field(default=None, max_length=TOKEN_MAX_CHARS)
    #: Optional email to pre-select in Google's account chooser.
    login_hint: str | None = Field(default=None, max_length=255)


class StartOut(BaseModel):
    authorization_url: str
    #: Keep it (HttpOnly cookie / sessionStorage) and compare with the
    #: `state` Google returns BEFORE calling /callback.
    state: str
    expires_in: int


class CallbackIn(BaseModel):
    code: str = Field(min_length=1, max_length=4096)
    state: str = Field(min_length=1, max_length=4096)
    #: The same redirect_uri that was given to /start.
    redirect_uri: str = Field(min_length=1, max_length=2048)


class SigninOut(TokenOut):
    intent: Literal["signin"] = "signin"
    #: True when this sign-in created the account.
    created: bool = False
    #: True when this sign-in linked Google to an existing account.
    linked: bool = False


class LinkOut(BaseModel):
    intent: Literal["link"] = "link"
    google_email: str | None


class ReauthOut(BaseModel):
    intent: Literal["reauth"] = "reauth"
    #: Pass to POST /auth/delete-account as `reauth_token`.
    reauth_token: str
    expires_in: int


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("/config", response_model=ConfigOut)
async def google_config() -> ConfigOut:
    """Whether to show the Google button. Never 503 — `enabled: false` instead."""
    s = get_settings()
    enabled = google_oauth.google_enabled(s)
    return ConfigOut(enabled=enabled, redirect_uris=list(s.google_redirect_uri_set) if enabled else [])


@router.post("/start", response_model=StartOut)
async def google_start(
    body: StartIn,
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: CoreSession,
) -> StartOut:
    _require_configured()
    await ratelimit.enforce([(ratelimit.GOOGLE_START_IP, ratelimit.client_ip(request))])
    if not google_oauth.redirect_uri_allowed(body.redirect_uri):
        raise _refuse(400, "redirect_uri_not_allowed")

    user_id: int | None = None
    captcha_ok = False
    if body.intent in ("link", "reauth"):
        auth = await _caller(request, creds, session)
        user_id = auth.user_id
        if body.intent == "link":
            _require_verified_for_link(auth)
        if body.intent == "reauth" and await _identity_of_user(session, auth.user_id) is None:
            raise _refuse(409, "no_google_link")
    else:
        secret = (get_settings().turnstile_secret_key or "").strip()
        if not secret:
            captcha_ok = True
        elif body.turnstile_token:
            # Verified NOW (the token lives 300 s; Google's round trip may
            # not). Only account CREATION needs it; a returning user may
            # start without one.
            if not await verify_turnstile(body.turnstile_token, secret):
                raise _refuse(400, "captcha_failed")
            captcha_ok = True
    try:
        started = await google_oauth.start_flow(
            redirect_uri=body.redirect_uri,
            intent=body.intent,
            user_id=user_id,
            captcha_ok=captcha_ok,
            login_hint=body.login_hint,
        )
    except GoogleOAuthError as exc:
        raise _from_flow_error(exc) from None
    except FlowStoreUnavailable:
        raise _refuse(503, "store_unavailable") from None
    return StartOut(
        authorization_url=started.authorization_url, state=started.state, expires_in=started.expires_in
    )


@router.post("/callback", response_model=SigninOut | LinkOut | ReauthOut)
async def google_callback(
    body: CallbackIn,
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: CoreSession,
) -> SigninOut | LinkOut | ReauthOut:
    _require_configured()
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([(ratelimit.GOOGLE_CALLBACK_IP, ip)])
    try:
        flow = await google_oauth.finish_flow(
            code=body.code, state=body.state, redirect_uri=body.redirect_uri
        )
    except GoogleOAuthError as exc:
        raise _from_flow_error(exc) from None
    except FlowStoreUnavailable:
        raise _refuse(503, "store_unavailable") from None

    if flow.intent == "signin":
        return await _signin(session, request, flow.identity, captcha_ok=flow.captcha_ok)

    # link / reauth: the caller must be the user who started the flow.
    auth = await _caller(request, creds, session)
    if flow.user_id is None or flow.user_id != auth.user_id:
        raise _refuse(403, "wrong_account")
    if flow.intent == "link":
        _require_verified_for_link(auth)
        return await _link(session, auth, flow.identity)
    identity = await _identity_of_user(session, auth.user_id)
    if identity is None or identity.subject != flow.identity.sub:
        raise _refuse(403, "not_linked_google")
    identity.last_login_at = datetime.now(UTC)
    await session.commit()
    log.info("google_reauth", user_id=auth.user_id)
    return ReauthOut(
        reauth_token=encode_reauth(auth.user_id, int(auth.user.token_version or 0)),
        expires_in=REAUTH_TTL_SEC,
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def google_unlink(auth: CurrentUser, session: CoreSession) -> None:
    """Remove the Google link. Refused while the account has no password —
    it would be left with no way to sign in."""
    identity = await _identity_of_user(session, auth.user_id)
    if identity is None:
        raise _refuse(404, "no_google_link")
    if not has_usable_password(auth.user.password_hash):
        raise _refuse(409, "password_required")
    await session.delete(identity)
    await session.commit()
    log.info("google_unlinked", user_id=auth.user_id)


# ── the policy ────────────────────────────────────────────────────────────────

async def _identity_of_user(session: AsyncSession, user_id: int) -> OAuthIdentity | None:
    return (
        await session.execute(
            select(OAuthIdentity).where(
                OAuthIdentity.user_id == user_id, OAuthIdentity.provider == PROVIDER_GOOGLE
            )
        )
    ).scalar_one_or_none()


async def _identity_by_sub(session: AsyncSession, sub: str) -> OAuthIdentity | None:
    return (
        await session.execute(
            select(OAuthIdentity).where(
                OAuthIdentity.provider == PROVIDER_GOOGLE, OAuthIdentity.subject == sub
            )
        )
    ).scalar_one_or_none()


async def _pair_for(session: AsyncSession, user: User) -> TokenOut:
    tenant = await _home_tenant(session, user)
    if tenant is None:
        raise _refuse(403, "no_tenant")
    return await _tokens_for(user, tenant)


async def _signin(
    session: AsyncSession, request: Request, google: GoogleIdentity, *, captcha_ok: bool
) -> SigninOut:
    now = datetime.now(UTC)

    # 1. A known Google identity: `sub` decides, nothing else.
    known = await _identity_by_sub(session, google.sub)
    if known is not None:
        user = (await session.execute(select(User).where(User.id == known.user_id))).scalar_one()
        if not user.is_active or user.deleted_at is not None:
            raise _refuse(403, "account_disabled")
        known.last_login_at = now
        if google.email:
            known.email = google.email
        await session.commit()
        log.info("google_signin", user_id=user.id)
        return SigninOut(**(await _pair_for(session, user)).model_dump())

    # 2. An unverified Google email is trusted for nothing.
    if not google.email or not google.email_verified:
        raise _refuse(403, "email_not_verified")

    # 3. Someone already uses the address.
    existing = (
        await session.execute(
            select(User).where(func.lower(User.email) == google.email).order_by(User.id).limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        if not existing.is_active or existing.deleted_at is not None:
            raise _refuse(403, "account_disabled")
        if (
            existing.email_verified_at is None
            or existing.is_admin
            or await _identity_of_user(session, int(existing.id)) is not None
        ):
            log.info("google_link_refused", user_id=existing.id, reason="needs explicit link")
            raise _refuse(409, "link_requires_password")
        session.add(OAuthIdentity(
            user_id=int(existing.id), provider=PROVIDER_GOOGLE, subject=google.sub,
            email=google.email, last_login_at=now,
        ))
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise _refuse(409, "try_again") from None
        log.info("google_auto_linked", user_id=existing.id)
        return SigninOut(**(await _pair_for(session, existing)).model_dump(), linked=True)

    # 4. A new account — the same gates as POST /auth/register.
    if not get_settings().allow_registration:
        raise _refuse(403, "registration_closed")
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([
        (ratelimit.REGISTER_EMAIL, google.email),
        (ratelimit.REGISTER_IP, ip),
        (ratelimit.REGISTER_IP_DAY, ip),
    ])
    if not captcha_ok:
        raise _refuse(400, "captcha_required")
    try:
        user, tenant = await create_account(
            session, email=google.email, password_hash=UNUSABLE_PASSWORD_HASH, display_name=google.name
        )
        user.email_verified_at = now
        user.signup_ip_hash = free_tier.identity_hash(ip)
        user.signup_device_hash = free_tier.identity_hash(request.headers.get(free_tier.DEVICE_HEADER))
        session.add(OAuthIdentity(
            user_id=int(user.id), provider=PROVIDER_GOOGLE, subject=google.sub,
            email=google.email, last_login_at=now,
        ))
        await session.commit()
    except IntegrityError:
        # Lost a race for the same address or the same Google account.
        await session.rollback()
        raise _refuse(409, "try_again") from None
    log.info("account_registered", user_id=user.id, tenant_slug=tenant.slug, via="google")
    return SigninOut(**(await _tokens_for(user, tenant)).model_dump(), created=True)


async def _link(session: AsyncSession, auth: AuthUser, google: GoogleIdentity) -> LinkOut:
    """Explicit link from settings: the caller is signed in (password or
    otherwise) and just passed Google — both identities are proven, so the
    Google email need not match the account's, nor be verified."""
    owner = await _identity_by_sub(session, google.sub)
    if owner is not None:
        if owner.user_id == auth.user_id:
            return LinkOut(google_email=owner.email)  # already linked: idempotent
        raise _refuse(409, "google_in_use")
    if await _identity_of_user(session, auth.user_id) is not None:
        raise _refuse(409, "already_linked")
    session.add(OAuthIdentity(
        user_id=auth.user_id, provider=PROVIDER_GOOGLE, subject=google.sub,
        email=google.email, last_login_at=datetime.now(UTC),
    ))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise _refuse(409, "google_in_use") from None
    log.info("google_linked", user_id=auth.user_id, google=mask_email(google.email or ""))
    return LinkOut(google_email=google.email)
