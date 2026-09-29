"""Auth endpoints: login, refresh, logout, me (+ profile), register, email
verification, password change/reset, email change.

Self-service registration is gated by ALLOW_REGISTRATION (default off) and,
when TURNSTILE_SECRET_KEY is set, by a server-verified Turnstile token. Each
new account gets its own tenant — see packages/auth/accounts.py. Mail goes out
through SendGrid (packages/email); links are single-use (packages/auth/
email_tokens.py). Every token carries `tv`: a password change or reset revokes
all earlier sessions. Rate limits: services/api/ratelimit.py.

Sessions (2026-09-27). Refresh tokens are single use: every one carries a
`jti` registered in packages/auth/refresh_store.py (Redis), and
`POST /auth/refresh` spends it and returns a NEW pair — the presented token
never works twice. Presenting an already-spent token is treated as theft:
the user's `token_version` is bumped (every session, stolen and honest, is
signed out) and the request gets 401. `tv` stays the nuclear path (password
change / reset); logout below is the gentle one.

    POST /auth/refresh    Authorization: Bearer <refresh_token>
        200 {access_token, refresh_token, token_type: "bearer"}  (unchanged shape)
        401 invalid / expired / revoked / already used / store unreachable
            (a refresh the store cannot verify is refused — never assumed)

    POST /auth/logout     Authorization: Bearer <ACCESS token>
        body (optional): {"refresh_token": "<the session's refresh token>"}
        204 always on success:
            with a refresh token  → that one session's refresh token is dropped
                                    (an expired or already-dropped one is a no-op)
            without one           → every refresh token of the user is dropped
        400 the body's refresh token is not this user's / not a refresh token
        503 the store is unreachable (nothing was dropped; try again)
        The access token itself is NOT revoked — it dies on its own `exp`
        (30 min). Only a `tv` bump kills access tokens early.

Deploy grace: a refresh token issued before rotation shipped has no `jti`.
It is accepted ONCE (its hash is remembered in the store) and answered with
a rotated pair, so nobody signed in at the time of the deploy is thrown out.
Presenting it a second time is a plain 401 — not the theft path, because a
client that pre-dates rotation may retry honestly. The last such token
expires 14 days (`jwt_refresh_ttl`) after the deploy.
"""

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Literal

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, EmailStr, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from packages.auth import refresh_store
from packages.auth.accounts import (
    DISPLAY_NAME_MAX_CHARS,
    create_account,
    email_taken,
    has_usable_password,
    normalize_display_name,
    normalize_email,
    password_problem,
)
from packages.auth.email_tokens import (
    PURPOSE_CHANGE_EMAIL,
    PURPOSE_RESET_PASSWORD,
    PURPOSE_VERIFY_EMAIL,
    InvalidToken,
    consume_token,
    issue_token,
    void_tokens,
)
from packages.auth.hashing import dummy_hash, hash_password, verify_password
from packages.auth.refresh_store import Consume, RefreshStoreUnavailable
from packages.auth.tokens import (
    decode,
    encode_access,
    encode_refresh,
    new_jti,
    token_version_matches,
)
from packages.auth.turnstile import TOKEN_MAX_CHARS, verify_turnstile
from packages.billing import free_tier
from packages.billing.client import billing_enabled, get_stripe_client
from packages.billing.service import sync_customer_email
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.core_auth import Membership, Tenant, User
from packages.db.models.oauth_identity import PROVIDER_GOOGLE, OAuthIdentity
from packages.email import templates
from packages.email.message import (
    Address,
    EmailSendError,
    Mailer,
    OutgoingEmail,
    email_fingerprint,
    mask_email,
)
from services.api import ratelimit
from services.api.deps import CurrentUser, MailerDep, OptionalMailerDep, core_session

log = get_logger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]

_INVALID_LINK = "this link is invalid, has expired or was already used"


# ── schemas ───────────────────────────────────────────────────────────────────

def _checked_password(value: str) -> str:
    problem = password_problem(value)
    if problem:
        raise ValueError(problem)
    return value


def _checked_display_name(value: str | None) -> str | None:
    name = normalize_display_name(value)
    if name is not None and len(name) > DISPLAY_NAME_MAX_CHARS:
        raise ValueError(f"display_name must be at most {DISPLAY_NAME_MAX_CHARS} characters")
    return name


#: >= 8 characters and <= 72 UTF-8 bytes (bcrypt's limit) — 422 otherwise.
NewPassword = Annotated[str, AfterValidator(_checked_password)]
#: Trimmed; blank becomes null; <= 80 characters.
DisplayName = Annotated[str | None, AfterValidator(_checked_display_name)]
TurnstileToken = Annotated[str | None, Field(default=None, max_length=TOKEN_MAX_CHARS)]
#: Bounded against absurd payloads only: a malformed or over-long token is a
#: 400 "invalid link" from consume_token, as the contract says, not a 422.
EmailToken = Annotated[str, Field(min_length=1, max_length=2048)]


class LoginIn(BaseModel):
    email: str
    password: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: NewPassword
    display_name: DisplayName = None
    turnstile_token: TurnstileToken = None


class ProfileIn(BaseModel):
    # Required key, nullable value: `{"display_name": null}` (or "") clears it.
    display_name: DisplayName


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: NewPassword


class VerifyEmailIn(BaseModel):
    token: EmailToken


class VerifyEmailOut(BaseModel):
    email: str
    purpose: Literal["verify_email", "change_email"]


class ForgotPasswordIn(BaseModel):
    email: EmailStr
    turnstile_token: TurnstileToken = None


class ResetPasswordIn(BaseModel):
    token: EmailToken
    new_password: NewPassword


class ChangeEmailIn(BaseModel):
    new_email: EmailStr
    current_password: str


class EmptyOut(BaseModel):
    """`{}` — the 202 bodies."""


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LogoutIn(BaseModel):
    #: The session's refresh token, to drop just that session. Absent (or
    #: null): every refresh token of the caller is dropped.
    refresh_token: str | None = Field(default=None, max_length=4096)


class MeOut(BaseModel):
    user_id: int
    email: str
    tenant_id: int
    tenant_slug: str
    role: str
    is_admin: bool
    display_name: str | None
    email_verified: bool
    #: False for an account created through Google that never set a password
    #: (it can set one with forgot-password). Clients hide "change password"
    #: and ask for a Google re-auth instead of a password where it is False.
    has_password: bool = True
    #: Whether a Google identity is linked, and its email (informational).
    google_linked: bool = False
    google_email: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


_STORE_DOWN = "sign-in is temporarily unavailable — please try again in a moment"


async def _issue_pair(user: User, tenant: Tenant) -> TokenOut:
    """A fresh pair; raises RefreshStoreUnavailable when the `jti` could not
    be recorded. The refresh token's `jti` is registered BEFORE the token is
    handed out: a token the store does not know is refused at /refresh, so
    issuing one the store failed to record would only sign the user out 30
    minutes later, confusingly. Refusing now is the honest answer."""
    version = int(user.token_version or 0)
    jti = new_jti()
    await refresh_store.get_store().issue(int(user.id), jti, get_settings().jwt_refresh_ttl)
    return TokenOut(
        access_token=encode_access(int(user.id), int(tenant.id), str(tenant.slug), version),
        refresh_token=encode_refresh(int(user.id), int(tenant.id), version, jti=jti),
    )


async def _tokens_for(user: User, tenant: Tenant) -> TokenOut:
    """`_issue_pair` for the sign-in routes: a store outage is their 503."""
    try:
        return await _issue_pair(user, tenant)
    except RefreshStoreUnavailable:
        raise HTTPException(status_code=503, detail=_STORE_DOWN) from None


def _seconds_left(payload: dict[str, object]) -> int:
    """How long a decoded token still has (its tombstone need not outlive it)."""
    exp = payload.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, int | float):
        return get_settings().jwt_refresh_ttl
    return max(1, int(exp - datetime.now(UTC).timestamp()))


async def _me_out(auth: CurrentUser, session: AsyncSession) -> MeOut:
    mem = (
        await session.execute(
            select(Membership).where(
                Membership.user_id == auth.user_id,
                Membership.tenant_id == auth.tenant_id,
            )
        )
    ).scalar_one_or_none()
    google = (
        await session.execute(
            select(OAuthIdentity).where(
                OAuthIdentity.user_id == auth.user_id, OAuthIdentity.provider == PROVIDER_GOOGLE
            )
        )
    ).scalar_one_or_none()
    return MeOut(
        user_id=auth.user_id,
        email=str(auth.user.email),
        tenant_id=auth.tenant_id,
        tenant_slug=auth.tenant_slug,
        role=str(mem.role) if mem else "unknown",
        is_admin=bool(auth.user.is_admin),
        display_name=auth.user.display_name,
        email_verified=auth.user.email_verified_at is not None,
        has_password=has_usable_password(auth.user.password_hash),
        google_linked=google is not None,
        google_email=google.email if google is not None else None,
    )


def _password_matches(plain: str, hashed: str) -> bool:
    """`verify_password`, except a password bcrypt refuses (>72 bytes) is a mismatch.

    An account with no password (Google-only) still pays one bcrypt check
    against the dummy hash, so a Google-only address answers exactly as slowly
    as a wrong password — no timing tell of how the account signs in.
    """
    if not has_usable_password(hashed):
        try:
            verify_password(plain, dummy_hash())
        except ValueError:
            pass
        return False
    try:
        return verify_password(plain, hashed)
    except ValueError:
        return False


def _registration_open() -> None:
    """Runs before the body is validated: a closed door answers 403 to anything."""
    if not get_settings().allow_registration:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="registration is currently closed",
        )


async def _require_turnstile(token: str | None) -> None:
    secret = (get_settings().turnstile_secret_key or "").strip()
    if secret and not (token and await verify_turnstile(token, secret)):
        raise HTTPException(status_code=400, detail="captcha verification failed")


async def _active_user_by_email(session: AsyncSession, email: str) -> User | None:
    """Exact stored spelling first (every pre-existing login), then any case."""
    user = (
        await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
    ).scalar_one_or_none()
    if user is None:
        user = (
            await session.execute(
                select(User)
                .where(func.lower(User.email) == normalize_email(email), User.is_active.is_(True))
                .order_by(User.id)
                .limit(1)
            )
        ).scalar_one_or_none()
    return user


async def _home_tenant(session: AsyncSession, user: User) -> Tenant | None:
    """The tenant a fresh login lands in (the user's membership)."""
    mem = (
        await session.execute(select(Membership).where(Membership.user_id == user.id).limit(1))
    ).scalar_one_or_none()
    if mem is None:
        return None
    return (await session.execute(select(Tenant).where(Tenant.id == mem.tenant_id))).scalar_one_or_none()


async def _revoke_sessions(session: AsyncSession, user: User) -> None:
    """Bump token_version: every token issued before stops working."""
    new_version = (
        await session.execute(
            update(User)
            .where(User.id == user.id)
            .values(token_version=User.token_version + 1)
            .returning(User.token_version)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one()
    set_committed_value(user, "token_version", new_version)


async def _drop_oauth_identities(session: AsyncSession, user: User) -> None:
    """Forget every linked sign-in identity (Google) for this account.

    Called where the mailbox owner proves themselves for the first time, or
    takes the account back with a reset link. A link made before that was not
    made by a proven owner — a squatter who registered the address first could
    link their own Google account, and without this it survived the real
    owner's reset and signed the squatter straight back in. The owner can link
    again from settings.
    """
    await session.execute(delete(OAuthIdentity).where(OAuthIdentity.user_id == user.id))


def _brand() -> str:
    return get_settings().email_from_name.strip() or "Noey Studio"


def _link(path: str, token: str) -> str:
    return templates.build_link(get_settings().site_url, path, token)


async def _send_now(mailer: Mailer, message: OutgoingEmail) -> None:
    """Send while the caller waits; a provider failure is the caller's 503."""
    try:
        await mailer.send(message)
    except EmailSendError:
        raise HTTPException(
            status_code=503, detail="the email could not be sent right now — please try again later"
        ) from None


async def _send_quietly(mailer: Mailer, message: OutgoingEmail) -> None:
    """Best effort (background tasks, courtesy notices): failures are only logged."""
    try:
        await mailer.send(message)
    except EmailSendError:
        log.warning("email_not_delivered", category=message.category, to=mask_email(message.to.email))


def _name_for_mail(user: User) -> str | None:
    """The account's display name for a mail header / greeting — only once
    the address is proven. Before that the name was typed by whoever
    registered the address, and anyone can register anyone's: 80 characters
    of their text in the To header and greeting of a genuine Noey mail to the
    victim is content spoofing (phishing inside our own mail)."""
    return user.display_name if user.email_verified_at is not None else None


def _verification_mail(user: User, raw_token: str) -> OutgoingEmail:
    # Always to an unproven address: never the registrant's chosen name.
    return OutgoingEmail(
        to=Address(str(user.email), None),
        content=templates.verify_email(
            brand=_brand(),
            link=_link(templates.VERIFY_PATH, raw_token),
            display_name=None,
        ),
        category=PURPOSE_VERIFY_EMAIL,
    )


# ── login / refresh / me ──────────────────────────────────────────────────────

@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, request: Request, session: CoreSession) -> TokenOut:
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([
        (ratelimit.LOGIN_EMAIL_IP, f"{normalize_email(body.email)}|{ip}"),
        (ratelimit.LOGIN_EMAIL, normalize_email(body.email)),
        (ratelimit.LOGIN_IP, ip),
    ])

    user = await _active_user_by_email(session, body.email)
    # bcrypt runs whether or not the account exists (against a dummy hash
    # when it does not), so an unknown address takes as long as a wrong
    # password; and it runs off the event loop — ~100 ms of hashing would
    # otherwise stall every other request in this worker. `_password_matches`
    # turns the >72-byte refusal into a mismatch instead of a 500.
    hashed = str(user.password_hash) if user is not None else dummy_hash()
    matched = await asyncio.to_thread(_password_matches, body.password, hashed)
    if user is None or not matched:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    mem = (
        await session.execute(
            select(Membership).where(Membership.user_id == user.id)
        )
    ).scalar_one_or_none()
    if mem is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no tenant membership")

    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == mem.tenant_id))
    ).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="tenant not found")

    return await _tokens_for(user, tenant)


@router.post("/refresh", response_model=TokenOut)
async def refresh(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: CoreSession,
) -> TokenOut:
    if creds is None:
        raise HTTPException(status_code=401, detail="missing token")
    try:
        payload = decode(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid token") from None

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="not a refresh token")

    user_id = int(payload["sub"])
    tenant_id = int(payload["tid"])

    user = (
        await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    ).scalar_one_or_none()
    tenant = (
        await session.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()

    if user is None or tenant is None:
        raise HTTPException(status_code=401, detail="user/tenant not found")
    if not token_version_matches(payload, user.token_version):
        raise HTTPException(status_code=401, detail="token revoked")

    # Spend the presented token before minting the next one (module docstring).
    # Any store trouble here is a 401, not a 503: a refresh the store could
    # not verify is refused, and if it was verified but the store then failed
    # to record the new pair, the old one is already spent — either way the
    # client's only move is to sign in again, and 401 is what makes it do so.
    store = refresh_store.get_store()
    jti = payload.get("jti")
    try:
        if jti is None:
            # Pre-rotation token (deploy grace, module docstring): once only.
            if not await store.consume_legacy(user_id, creds.credentials, _seconds_left(payload)):
                raise HTTPException(status_code=401, detail="token already used")
        elif not isinstance(jti, str) or not jti:
            raise HTTPException(status_code=401, detail="invalid token")
        else:
            outcome = await store.consume(user_id, jti, _seconds_left(payload))
            if outcome is Consume.REUSED:
                # Someone holds a token that was already rotated away. We
                # cannot tell the thief from the owner, so both lose every
                # session; the owner signs in again, the thief cannot.
                log.warning("refresh_token_reuse", user_id=user_id)
                await _revoke_sessions(session, user)
                await session.commit()
                raise HTTPException(status_code=401, detail="token already used")
            if outcome is not Consume.SPENT:
                raise HTTPException(status_code=401, detail="token revoked")
        return await _issue_pair(user, tenant)
    except RefreshStoreUnavailable:
        raise HTTPException(status_code=401, detail="token could not be verified") from None


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def logout(auth: CurrentUser, body: LogoutIn | None = None) -> None:
    """Drop the caller's refresh token(s); contract in the module docstring.

    Takes the ACCESS token as bearer (the refresh token is a credential too,
    but the access token is what the client holds in memory and what every
    other route checks) and the refresh token in the body, if the client
    wants only this session gone. The refresh token is decoded WITHOUT
    checking `exp`: an expired one can still be the one the client means,
    and dropping a key that already expired is a harmless no-op.
    """
    store = refresh_store.get_store()
    raw = (body.refresh_token or "").strip() if body is not None else ""
    try:
        if not raw:
            dropped = await store.revoke_all(auth.user_id)
            log.info("logout_all", user_id=auth.user_id, dropped=dropped)
            return
        try:
            payload = decode(raw, verify_exp=False)
        except jwt.PyJWTError:
            raise HTTPException(status_code=400, detail="invalid refresh token") from None
        if payload.get("type") != "refresh" or str(payload.get("sub")) != str(auth.user_id):
            raise HTTPException(status_code=400, detail="invalid refresh token")
        jti = payload.get("jti")
        if isinstance(jti, str) and jti:
            await store.revoke(auth.user_id, jti)
        else:
            # A pre-rotation token has no id to drop: mark it spent instead,
            # so its one-time grace at /refresh is used up by this logout.
            await store.consume_legacy(auth.user_id, raw, _seconds_left(payload))
        log.info("logout", user_id=auth.user_id)
        return
    except RefreshStoreUnavailable:
        raise HTTPException(status_code=503, detail=_STORE_DOWN) from None


@router.get("/me", response_model=MeOut)
async def me(auth: CurrentUser, session: CoreSession) -> MeOut:
    return await _me_out(auth, session)


@router.patch("/me", response_model=MeOut)
async def update_me(body: ProfileIn, auth: CurrentUser, session: CoreSession) -> MeOut:
    """Edit the caller's own profile. Only `display_name` is editable today."""
    auth.user.display_name = body.display_name
    # Explicit: a yield dependency commits only after the response is sent.
    await session.commit()
    return await _me_out(auth, session)


# ── registration + verification ───────────────────────────────────────────────

@router.post(
    "/register",
    response_model=TokenOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_registration_open)],
)
async def register(
    body: RegisterIn,
    request: Request,
    background: BackgroundTasks,
    session: CoreSession,
    mailer: OptionalMailerDep,
) -> TokenOut:
    """Create a free-plan account with its own tenant, sign it in, and mail the
    verification link (skipped — logged — while email is not configured).

    403 while ALLOW_REGISTRATION is off (checked before the body), 400 when a
    required Turnstile token is missing or rejected, 409 when the address is
    taken (any capitalisation), 422 for an invalid body, 429 when throttled.
    """
    email = normalize_email(str(body.email))
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([
        (ratelimit.REGISTER_EMAIL, email),
        (ratelimit.REGISTER_IP, ip),
        (ratelimit.REGISTER_IP_DAY, ip),
    ])
    await _require_turnstile(body.turnstile_token)

    if await email_taken(session, email):
        raise HTTPException(status_code=409, detail="an account with this email already exists")

    password_hash = await asyncio.to_thread(hash_password, body.password)
    raw_token: str | None = None
    try:
        user, tenant = await create_account(
            session, email=email, password_hash=password_hash, display_name=body.display_name
        )
        # Salted hashes only (packages/billing/free_tier.py) — for spotting
        # many free accounts from one network / device, never the raw values.
        user.signup_ip_hash = free_tier.identity_hash(ip)
        user.signup_device_hash = free_tier.identity_hash(request.headers.get(free_tier.DEVICE_HEADER))
        if mailer is not None:
            raw_token = await issue_token(session, int(user.id), PURPOSE_VERIFY_EMAIL)
        # Commit BEFORE handing out tokens or mailing the link: a yield
        # dependency would only commit after the response, and a failed
        # commit would leave tokens (and a link) for nothing.
        await session.commit()
    except IntegrityError:
        await session.rollback()
        if await email_taken(session, email):  # lost a race for the same address
            raise HTTPException(
                status_code=409, detail="an account with this email already exists"
            ) from None
        raise

    if mailer is not None and raw_token is not None:
        # After the response: registration never waits on (or fails because
        # of) the mail provider. The user can resend from the account page.
        background.add_task(_send_quietly, mailer, _verification_mail(user, raw_token))
    else:
        log.warning("verification_email_skipped", user_id=user.id, reason="email not configured")
    log.info("account_registered", user_id=user.id, tenant_slug=tenant.slug)
    return await _tokens_for(user, tenant)


@router.post(
    "/resend-verification", status_code=status.HTTP_202_ACCEPTED, response_model=EmptyOut
)
async def resend_verification(
    request: Request, auth: CurrentUser, session: CoreSession, mailer: MailerDep
) -> EmptyOut:
    """Mail a fresh verification link (older ones stop working). 409 when the
    email is already verified."""
    if auth.user.email_verified_at is not None:
        raise HTTPException(status_code=409, detail="this email is already verified")
    await ratelimit.enforce([
        (ratelimit.RESEND_ACCOUNT, str(auth.user_id)),
        (ratelimit.RESEND_IP, ratelimit.client_ip(request)),
    ])
    raw_token = await issue_token(session, auth.user_id, PURPOSE_VERIFY_EMAIL)
    await session.commit()
    await _send_now(mailer, _verification_mail(auth.user, raw_token))
    return EmptyOut()


@router.post("/verify-email", response_model=VerifyEmailOut)
async def verify_email(body: VerifyEmailIn, session: CoreSession) -> VerifyEmailOut:
    """Consume a verification or email-change link.

    verify_email → the address is marked verified. change_email → the account
    switches to the new address (verified), and reset links mailed to the old
    one stop working. 400 for an unknown/expired/used link; 409 when the new
    address was taken by another account in the meantime (the link stays
    usable until it expires).
    """
    try:
        token = await consume_token(session, body.token, [PURPOSE_VERIFY_EMAIL, PURPOSE_CHANGE_EMAIL])
    except InvalidToken:
        raise HTTPException(status_code=400, detail=_INVALID_LINK) from None
    user = (
        await session.execute(select(User).where(User.id == token.user_id, User.is_active.is_(True)))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail=_INVALID_LINK)
    now = datetime.now(UTC)

    if token.purpose == PURPOSE_VERIFY_EMAIL:
        if user.email_verified_at is None:
            user.email_verified_at = now
            await _drop_oauth_identities(session, user)
        await session.commit()
        log.info("email_verified", user_id=user.id)
        return VerifyEmailOut(email=str(user.email), purpose="verify_email")

    new_email = normalize_email(token.new_email or "")
    if not new_email:
        raise HTTPException(status_code=400, detail=_INVALID_LINK)
    taken = (
        await session.execute(
            select(User.id).where(func.lower(User.email) == new_email, User.id != user.id).limit(1)
        )
    ).scalar_one_or_none()
    if taken is not None:
        # The dependency rolls back: the link is NOT spent.
        raise HTTPException(status_code=409, detail="an account with this email already exists")
    old_email = str(user.email)
    user.email = new_email
    user.email_verified_at = now
    await void_tokens(session, int(user.id), PURPOSE_RESET_PASSWORD)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="an account with this email already exists"
        ) from None
    log.info(
        "email_changed", user_id=user.id, old=mask_email(old_email), new=mask_email(new_email)
    )
    if billing_enabled():
        # Receipts and invoices follow the account's address (best effort).
        await sync_customer_email(session, get_stripe_client(), user)
    return VerifyEmailOut(email=new_email, purpose="change_email")


# ── passwords ─────────────────────────────────────────────────────────────────

@router.post("/change-password", response_model=TokenOut)
async def change_password(
    body: ChangePasswordIn, auth: CurrentUser, session: CoreSession
) -> TokenOut:
    """Replace the caller's password after re-checking the current one.

    Every other session is revoked (token_version bump); the calling session
    continues with the fresh tokens returned here.
    """
    await ratelimit.enforce([(ratelimit.CHANGE_PASSWORD_ACCOUNT, str(auth.user_id))])
    matches = await asyncio.to_thread(
        _password_matches, body.current_password, str(auth.user.password_hash)
    )
    if not matches:
        raise HTTPException(status_code=400, detail="current password is incorrect")
    auth.user.password_hash = await asyncio.to_thread(hash_password, body.new_password)
    await _revoke_sessions(session, auth.user)
    await session.commit()
    log.info("password_changed", user_id=auth.user_id)
    return await _tokens_for(auth.user, auth.tenant)


@router.post(
    "/forgot-password", status_code=status.HTTP_202_ACCEPTED, response_model=EmptyOut
)
async def forgot_password(
    body: ForgotPasswordIn,
    request: Request,
    background: BackgroundTasks,
    session: CoreSession,
    mailer: MailerDep,
) -> EmptyOut:
    """Mail a reset link — only if an active account uses this address.

    ALWAYS 202 `{}` either way, and the mail itself is sent after the response,
    so neither the status nor the timing tells whether the account exists.
    (503 only while email is not configured — a server fact, not an account one.)
    """
    email = normalize_email(str(body.email))
    await ratelimit.enforce([
        (ratelimit.FORGOT_EMAIL, email),
        (ratelimit.FORGOT_IP, ratelimit.client_ip(request)),
    ])
    await _require_turnstile(body.turnstile_token)

    user = await _active_user_by_email(session, email)
    if user is None:
        log.info("password_reset_unknown_address", email_id=email_fingerprint(email))
        return EmptyOut()
    raw_token = await issue_token(session, int(user.id), PURPOSE_RESET_PASSWORD)
    await session.commit()
    message = OutgoingEmail(
        to=Address(str(user.email), _name_for_mail(user)),
        content=templates.reset_password(
            brand=_brand(), link=_link(templates.RESET_PATH, raw_token)
        ),
        category=PURPOSE_RESET_PASSWORD,
    )
    background.add_task(_send_quietly, mailer, message)
    log.info("password_reset_requested", user_id=user.id)
    return EmptyOut()


@router.post("/reset-password", response_model=TokenOut)
async def reset_password(body: ResetPasswordIn, session: CoreSession) -> TokenOut:
    """Set a new password from a reset link and sign in.

    Revokes every earlier session and marks the email verified (the link
    proved the mailbox). 400 for an unknown/expired/used link.
    """
    try:
        token = await consume_token(session, body.token, [PURPOSE_RESET_PASSWORD])
    except InvalidToken:
        raise HTTPException(status_code=400, detail=_INVALID_LINK) from None
    user = (
        await session.execute(select(User).where(User.id == token.user_id, User.is_active.is_(True)))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail=_INVALID_LINK)
    tenant = await _home_tenant(session, user)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no tenant membership")

    user.password_hash = await asyncio.to_thread(hash_password, body.new_password)
    if user.email_verified_at is None:
        user.email_verified_at = datetime.now(UTC)
    await _drop_oauth_identities(session, user)
    await _revoke_sessions(session, user)
    await session.commit()
    log.info("password_reset", user_id=user.id)
    return await _tokens_for(user, tenant)


# ── email change ──────────────────────────────────────────────────────────────

@router.post("/change-email", status_code=status.HTTP_202_ACCEPTED, response_model=EmptyOut)
async def change_email(
    body: ChangeEmailIn,
    request: Request,
    auth: CurrentUser,
    session: CoreSession,
    mailer: MailerDep,
) -> EmptyOut:
    """Start an email change: a confirmation link to the NEW address, a heads-up
    to the OLD one. Nothing changes until the link is opened (POST /auth/verify-email).

    400 wrong current password, 409 the address is already in use (including
    by this account), 429 throttled, 503 email not configured / not sent.
    """
    await ratelimit.enforce([
        (ratelimit.CHANGE_EMAIL_ACCOUNT, str(auth.user_id)),
        (ratelimit.CHANGE_EMAIL_IP, ratelimit.client_ip(request)),
    ])
    matches = await asyncio.to_thread(
        _password_matches, body.current_password, str(auth.user.password_hash)
    )
    if not matches:
        raise HTTPException(status_code=400, detail="current password is incorrect")

    new_email = normalize_email(str(body.new_email))
    if new_email == normalize_email(str(auth.user.email)):
        raise HTTPException(status_code=409, detail="this is already the account's email")
    if await email_taken(session, new_email):
        raise HTTPException(status_code=409, detail="an account with this email already exists")

    raw_token = await issue_token(session, auth.user_id, PURPOSE_CHANGE_EMAIL, new_email=new_email)
    await session.commit()
    brand = _brand()
    await _send_now(mailer, OutgoingEmail(
        # The new address is not proven yet: no caller-chosen name on it.
        to=Address(new_email, None),
        content=templates.change_email_confirm(
            brand=brand, link=_link(templates.VERIFY_PATH, raw_token), new_email=new_email
        ),
        category=PURPOSE_CHANGE_EMAIL,
    ))
    # The heads-up is a courtesy on top of the real safeguards (the password
    # re-check, and the change only happening from the new mailbox): best effort.
    await _send_quietly(mailer, OutgoingEmail(
        to=Address(str(auth.user.email), auth.user.display_name),
        content=templates.change_email_notice(brand=brand, new_email=new_email),
        category="change_email_notice",
    ))
    log.info("email_change_requested", user_id=auth.user_id, new=mask_email(new_email))
    return EmptyOut()
