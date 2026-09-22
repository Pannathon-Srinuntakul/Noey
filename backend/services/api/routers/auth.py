"""Auth endpoints: login, refresh, me (+ profile), register, email verification,
password change/reset, email change.

Self-service registration is gated by ALLOW_REGISTRATION (default off) and,
when TURNSTILE_SECRET_KEY is set, by a server-verified Turnstile token. Each
new account gets its own tenant — see packages/auth/accounts.py. Mail goes out
through SendGrid (packages/email); links are single-use (packages/auth/
email_tokens.py). Every token carries `tv`: a password change or reset revokes
all earlier sessions. Rate limits: services/api/ratelimit.py.
"""

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Literal

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, EmailStr, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from packages.auth.accounts import (
    DISPLAY_NAME_MAX_CHARS,
    create_account,
    email_taken,
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
from packages.auth.hashing import hash_password, verify_password
from packages.auth.tokens import decode, encode_access, encode_refresh, token_version_matches
from packages.auth.turnstile import TOKEN_MAX_CHARS, verify_turnstile
from packages.billing import free_tier
from packages.billing.client import billing_enabled, get_stripe_client
from packages.billing.service import sync_customer_email
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.core_auth import Membership, Tenant, User
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


class MeOut(BaseModel):
    user_id: int
    email: str
    tenant_id: int
    tenant_slug: str
    role: str
    is_admin: bool
    display_name: str | None
    email_verified: bool


# ── helpers ───────────────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False)


async def _tokens_for(user: User, tenant: Tenant) -> TokenOut:
    version = int(user.token_version or 0)
    return TokenOut(
        access_token=encode_access(int(user.id), int(tenant.id), str(tenant.slug), version),
        refresh_token=encode_refresh(int(user.id), int(tenant.id), version),
    )


async def _me_out(auth: CurrentUser, session: AsyncSession) -> MeOut:
    mem = (
        await session.execute(
            select(Membership).where(
                Membership.user_id == auth.user_id,
                Membership.tenant_id == auth.tenant_id,
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
    )


def _password_matches(plain: str, hashed: str) -> bool:
    """`verify_password`, except a password bcrypt refuses (>72 bytes) is a mismatch."""
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


def _verification_mail(user: User, raw_token: str) -> OutgoingEmail:
    return OutgoingEmail(
        to=Address(str(user.email), user.display_name),
        content=templates.verify_email(
            brand=_brand(),
            link=_link(templates.VERIFY_PATH, raw_token),
            display_name=user.display_name,
        ),
        category=PURPOSE_VERIFY_EMAIL,
    )


# ── login / refresh / me ──────────────────────────────────────────────────────

@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, request: Request, session: CoreSession) -> TokenOut:
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([
        (ratelimit.LOGIN_EMAIL_IP, f"{normalize_email(body.email)}|{ip}"),
        (ratelimit.LOGIN_IP, ip),
    ])

    user = await _active_user_by_email(session, body.email)
    if user is None or not verify_password(body.password, str(user.password_hash)):
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

    return await _tokens_for(user, tenant)


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
        to=Address(str(user.email), user.display_name),
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
        to=Address(new_email, auth.user.display_name),
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
