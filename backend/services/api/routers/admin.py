"""Admin dashboard API — only the admin app (admin/, a server-side BFF) calls it.

Login (no session yet; every step rate-limited, logged and lockout-checked):
POST /admin/auth/login     password → emailed 6-digit code, or straight in on a
                           remembered device
POST /admin/auth/verify    the code → admin session (+ remembered device)
POST /admin/auth/resend    a new code for the same pending login
POST /admin/auth/refresh   a new access token while the session is alive

Behind ``current_admin`` (services/api/admin_deps.py):
GET  /admin/auth/me                 POST /admin/auth/logout
GET  /admin/dashboard               GET  /admin/users/{id}
PATCH /admin/users/{id}/plan        POST /admin/users/{id}/quota-reset (all windows)
PATCH /admin/users/{id}/active      POST /admin/users/{id}/window-reset
POST /admin/users/{id}/wallet-adjust
GET/PUT /admin/cost-config          GET/PUT /admin/plan-prices
GET/PUT /admin/fx                   POST /admin/fx/refresh
GET  /admin/reconciliation          PUT  /admin/reconciliation/{month}
GET  /admin/estimate-accuracy       GET/PUT /admin/billing-config
GET/PUT /admin/circuit-breaker      GET  /admin/audit

The admin sees REAL rate-card tokens and baht (users only ever see
percentages): per-user windows, runs (estimate / actual / charged / cost),
wallet balances.

Every write is audited with before/after (core.admin_audit_events). Responses
carry no password hash, token or payment secret. Money is computed by the admin
app from the facts returned here — see packages/admin/metrics.py.
"""

import sys
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

import jwt
import stripe
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from packages.admin import accuracy
from packages.admin import auth as admin_auth
from packages.admin import billing_config as billing_cfg
from packages.admin import metrics
from packages.admin import reconciliation as recon
from packages.admin.cost_config import (
    CostConfig,
    default_model_price,
    known_stt_prices,
    load_cost_config,
    save_cost_config,
)
from packages.admin.pricing import MAX_PRICE_THB, PriceChangeError, change_prices, current_prices
from packages.auth.accounts import normalize_email
from packages.billing import catalog, fx, guard, rate_card, runs, vendor_cost, wallet
from packages.billing.accounts import get_account as get_usage_account
from packages.billing.client import billing_enabled, get_stripe_client
from packages.billing.service import get_account
from packages.core.logging import get_logger
from packages.core.settings import get_settings, is_local_deployment
from packages.db.models.admin import AdminAuditEvent, AdminLoginChallenge, AdminSession
from packages.db.models.core_auth import PLAN_VALUES, User
from packages.email import templates
from packages.email.message import Address, EmailSendError, Mailer, OutgoingEmail, mask_email
from services.api import ratelimit
from services.api.admin_deps import CurrentAdmin, admin_ip_allowed
from services.api.deps import OptionalMailerDep, core_session

log = get_logger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(admin_ip_allowed)])

CoreSession = Annotated[AsyncSession, Depends(core_session)]

#: The one answer for every failed password step: unknown address, wrong
#: password, not an admin and deactivated all look the same.
BAD_CREDENTIALS = "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
BAD_CODE = "รหัสไม่ถูกต้องหรือหมดอายุ — ถ้าลองผิดหลายครั้ง ให้เข้าสู่ระบบใหม่"
LOCKED = "ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่"

Password = Annotated[str, StringConstraints(min_length=1, max_length=200)]
Opaque = Annotated[str, StringConstraints(min_length=1, max_length=128)]


# ── schemas ───────────────────────────────────────────────────────────────────

class LoginIn(BaseModel):
    email: Annotated[str, StringConstraints(min_length=3, max_length=255)]
    password: Password
    device_token: Opaque | None = None


class VerifyIn(BaseModel):
    challenge_id: Opaque
    code: Annotated[str, StringConstraints(min_length=1, max_length=12)]
    remember_device: bool = True


class ChallengeIn(BaseModel):
    challenge_id: Opaque


class RefreshIn(BaseModel):
    refresh_token: Annotated[str, StringConstraints(min_length=1, max_length=4096)]


class LogoutIn(BaseModel):
    #: The remembered-device token to forget too (next login asks for a code).
    device_token: Opaque | None = None


class SessionOut(BaseModel):
    status: Literal["signed_in"] = "signed_in"
    access_token: str
    refresh_token: str
    access_expires_in: int
    device_token: str | None = None
    device_expires_at: datetime | None = None
    email: str


class ChallengeOut(BaseModel):
    status: Literal["otp_required"] = "otp_required"
    challenge_id: str
    sent_to: str
    expires_in: int


class AdminMeOut(BaseModel):
    user_id: int
    email: str
    display_name: str | None
    session_expires_at: datetime
    idle_timeout_sec: int


class PlanIn(BaseModel):
    plan: Literal["free", "lite", "starter", "pro", "studio", "agency", "max", "enterprise"]


class ActiveIn(BaseModel):
    active: bool


class FxIn(BaseModel):
    #: THB per USD; null clears the override (back to the fetched rate).
    usd_thb: float | None = Field(default=None, ge=fx.SANE_BAND[0], le=fx.SANE_BAND[1])


class WindowResetIn(BaseModel):
    window: Literal["five_hour", "weekly", "monthly"]


class WalletAdjustIn(BaseModel):
    #: Signed satang: positive credits a 12-month ``admin`` lot, negative
    #: takes from the balance (never below zero).
    amount_satang: int = Field(ge=-10_000_000, le=10_000_000)
    note: Annotated[str, StringConstraints(min_length=1, max_length=200, strip_whitespace=True)]


class BreakerIn(BaseModel):
    enabled: bool
    daily_cap_thb: float = Field(ge=0, le=10_000_000)
    hard_stop_ratio: float = Field(default=1.25, ge=1.0, le=10.0)
    alert_email: Annotated[str, StringConstraints(max_length=255, strip_whitespace=True)] | None = None


class InvoiceIn(BaseModel):
    vendor: Literal["gemini", "elevenlabs"]
    amount_thb: float = Field(ge=0, le=100_000_000)
    note: Annotated[str, StringConstraints(max_length=200, strip_whitespace=True)] | None = None


class PricesIn(BaseModel):
    #: THB per month, whole baht, per paid tier. Only changed tiers need be sent.
    prices: dict[
        Literal["lite", "starter", "pro", "studio", "agency", "max"],
        Annotated[int, Field(ge=1, le=MAX_PRICE_THB)],
    ] = Field(min_length=1, max_length=6)


class UserActionOut(BaseModel):
    user_id: int
    plan: str
    active: bool
    usage_reset_at: datetime | None


assert set(PlanIn.model_fields["plan"].annotation.__args__) == set(PLAN_VALUES)  # type: ignore[union-attr]


# ── helpers ───────────────────────────────────────────────────────────────────

def _ua(request: Request) -> str | None:
    return request.headers.get("user-agent")


def _session_out(sess: AdminSession, user: User, device: tuple[str, datetime] | None = None) -> SessionOut:
    tokens = admin_auth.issue_tokens(sess)
    return SessionOut(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        access_expires_in=tokens.access_expires_in,
        device_token=device[0] if device else None,
        device_expires_at=device[1] if device else None,
        email=str(user.email),
    )


async def _user_by_email(db: AsyncSession, email: str) -> User | None:
    return (
        await db.execute(select(User).where(func.lower(User.email) == email).order_by(User.id).limit(1))
    ).scalar_one_or_none()


async def _deliver_code(mailer: Mailer | None, user: User, code: str, ip: str) -> None:
    """Email the code. Without email configured, a developer's machine prints it
    to its own console (never through the structured log) — anywhere else the
    login cannot proceed."""
    if mailer is None:
        s = get_settings()
        if is_local_deployment(s.postgres_host) and not (s.sendgrid_api_key or "").strip():
            print(f"[DEV ONLY] admin login code for {mask_email(str(user.email))}: {code}", file=sys.stderr, flush=True)
            return
        raise HTTPException(status_code=503, detail="ส่งอีเมลรหัสยืนยันไม่ได้ในตอนนี้ — ระบบอีเมลยังไม่ได้ตั้งค่า")
    brand = get_settings().email_from_name.strip() or "Noey Studio"
    try:
        await mailer.send(
            OutgoingEmail(
                to=Address(str(user.email), user.display_name),
                content=templates.admin_login_code(brand=brand, code=code, ip=ip),
                category="admin_login_code",
            )
        )
    except EmailSendError:
        raise HTTPException(status_code=503, detail="ส่งอีเมลรหัสยืนยันไม่ได้ในตอนนี้ กรุณาลองใหม่") from None


async def _locked(db: AsyncSession, email: str) -> bool:
    return await admin_auth.recent_failures(db, email) >= admin_auth.LOCKOUT_FAILURES


async def _target(db: AsyncSession, user_id: int) -> User:
    user = (await db.execute(select(User).where(User.id == user_id).with_for_update())).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้")
    return user


def _action_out(user: User) -> UserActionOut:
    return UserActionOut(
        user_id=int(user.id), plan=str(user.plan), active=bool(user.is_active), usage_reset_at=user.usage_reset_at
    )


def _optional_stripe() -> stripe.StripeClient | None:
    return get_stripe_client() if billing_enabled() else None


OptionalStripe = Annotated[stripe.StripeClient | None, Depends(_optional_stripe)]


# ── login ────────────────────────────────────────────────────────────────────

@router.post("/auth/login", response_model=SessionOut | ChallengeOut)
async def login(
    body: LoginIn, request: Request, db: CoreSession, mailer: OptionalMailerDep
) -> SessionOut | ChallengeOut:
    ip = ratelimit.client_ip(request)
    email = normalize_email(body.email)
    await ratelimit.enforce([(ratelimit.ADMIN_LOGIN_EMAIL, email), (ratelimit.ADMIN_LOGIN_IP, ip)])

    if await _locked(db, email):
        await admin_auth.audit(db, "login_failed", email=email, ip=ip, user_agent=_ua(request), detail={"reason": "locked"})
        await db.commit()
        raise HTTPException(status_code=429, detail=LOCKED)

    user = await _user_by_email(db, email)
    password_ok = admin_auth.password_ok(user, body.password)
    if user is None or not password_ok or not user.is_admin or not user.is_active:
        reason = (
            "unknown_email" if user is None
            else "bad_password" if not password_ok
            else "not_admin" if not user.is_admin
            else "inactive"
        )
        await admin_auth.audit(
            db, "login_failed", actor_user_id=int(user.id) if user else None, email=email, ip=ip,
            user_agent=_ua(request), detail={"reason": reason},
        )
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=BAD_CREDENTIALS)

    device = await admin_auth.valid_device(db, user, body.device_token)
    if device is not None:
        device.last_used_at = admin_auth.now()
        sess = await admin_auth.start_session(db, user, ip, _ua(request))
        await admin_auth.audit(
            db, "login_success", actor_user_id=int(user.id), email=email, ip=ip, user_agent=_ua(request),
            detail={"method": "remembered_device"},
        )
        await db.commit()
        return _session_out(sess, user)

    challenge, code = await admin_auth.create_challenge(db, user, ip)
    await _deliver_code(mailer, user, code, ip)
    await admin_auth.audit(db, "login_otp_sent", actor_user_id=int(user.id), email=email, ip=ip, user_agent=_ua(request))
    await db.commit()
    return ChallengeOut(
        challenge_id=challenge.id,
        sent_to=mask_email(str(user.email)),
        expires_in=int(admin_auth.OTP_TTL.total_seconds()),
    )


@router.post("/auth/verify", response_model=SessionOut)
async def verify(body: VerifyIn, request: Request, db: CoreSession) -> SessionOut:
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([(ratelimit.ADMIN_OTP_CHALLENGE, body.challenge_id), (ratelimit.ADMIN_OTP_IP, ip)])

    challenge = await admin_auth.open_challenge(db, body.challenge_id)
    user = (
        (await db.execute(select(User).where(User.id == challenge.user_id))).scalar_one_or_none()
        if challenge is not None
        else None
    )
    email = normalize_email(str(user.email)) if user is not None else None
    if challenge is None or user is None or email is None:
        await admin_auth.audit(db, "login_otp_failed", ip=ip, user_agent=_ua(request), detail={"reason": "no_open_challenge"})
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=BAD_CODE)
    if await _locked(db, email):
        challenge.used_at = admin_auth.now()
        await admin_auth.audit(db, "login_otp_failed", actor_user_id=int(user.id), email=email, ip=ip,
                               user_agent=_ua(request), detail={"reason": "locked"})
        await db.commit()
        raise HTTPException(status_code=429, detail=LOCKED)

    if not admin_auth.code_matches(challenge, body.code):
        challenge.attempts += 1
        if challenge.attempts >= admin_auth.OTP_MAX_ATTEMPTS:
            challenge.used_at = admin_auth.now()
        await admin_auth.audit(
            db, "login_otp_failed", actor_user_id=int(user.id), email=email, ip=ip, user_agent=_ua(request),
            detail={"reason": "wrong_code", "attempts": challenge.attempts},
        )
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=BAD_CODE)

    challenge.used_at = admin_auth.now()
    if not user.is_admin or not user.is_active:
        await admin_auth.audit(db, "login_otp_failed", actor_user_id=int(user.id), email=email, ip=ip,
                               user_agent=_ua(request), detail={"reason": "no_longer_admin"})
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=BAD_CODE)

    sess = await admin_auth.start_session(db, user, ip, _ua(request))
    device = await admin_auth.remember_device(db, user, _ua(request)) if body.remember_device else None
    await admin_auth.audit(
        db, "login_success", actor_user_id=int(user.id), email=email, ip=ip, user_agent=_ua(request),
        detail={"method": "otp", "remembered_device": device is not None},
    )
    await db.commit()
    return _session_out(sess, user, device)


@router.post("/auth/resend", response_model=ChallengeOut)
async def resend(body: ChallengeIn, request: Request, db: CoreSession, mailer: OptionalMailerDep) -> ChallengeOut:
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([(ratelimit.ADMIN_RESEND_CHALLENGE, body.challenge_id), (ratelimit.ADMIN_RESEND_IP, ip)])
    challenge = await admin_auth.open_challenge(db, body.challenge_id)
    user = (
        (await db.execute(select(User).where(User.id == challenge.user_id))).scalar_one_or_none()
        if challenge is not None
        else None
    )
    if (
        challenge is None
        or user is None
        or challenge.resends >= admin_auth.OTP_MAX_RESENDS
        or not user.is_admin
        or not user.is_active
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="เข้าสู่ระบบใหม่อีกครั้ง")
    code = admin_auth.rotate_code(challenge)
    await _deliver_code(mailer, user, code, ip)
    await admin_auth.audit(db, "login_otp_sent", actor_user_id=int(user.id), email=str(user.email), ip=ip,
                           user_agent=_ua(request), detail={"resend": challenge.resends})
    await db.commit()
    return ChallengeOut(
        challenge_id=challenge.id,
        sent_to=mask_email(str(user.email)),
        expires_in=int(admin_auth.OTP_TTL.total_seconds()),
    )


@router.post("/auth/refresh", response_model=SessionOut)
async def refresh(body: RefreshIn, request: Request, db: CoreSession) -> SessionOut:
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce([(ratelimit.ADMIN_REFRESH_IP, ip)])
    denied = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="admin session required")
    try:
        payload = admin_auth.decode_admin_token(body.refresh_token, admin_auth.REFRESH_TYPE)
        user_id, sid, tv = int(payload["sub"]), str(payload["sid"]), payload.get("tv")
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise denied from None
    sess = (await db.execute(select(AdminSession).where(AdminSession.id == sid))).scalar_one_or_none()
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if (
        sess is None
        or isinstance(tv, bool)
        or sess.token_version != tv
        or sess.user_id != user_id
        or not admin_auth.session_alive(sess, user)
    ):
        raise denied
    assert user is not None
    admin_auth.touch(sess)
    await db.commit()
    return _session_out(sess, user)


@router.get("/auth/me", response_model=AdminMeOut)
async def me(admin: CurrentAdmin) -> AdminMeOut:
    return AdminMeOut(
        user_id=admin.user_id,
        email=str(admin.user.email),
        display_name=admin.user.display_name,
        session_expires_at=admin.session.expires_at,
        idle_timeout_sec=get_settings().admin_idle_timeout_sec,
    )


@router.post("/auth/logout", status_code=204)
async def logout(body: LogoutIn, admin: CurrentAdmin, db: CoreSession) -> None:
    admin.session.revoked_at = admin_auth.now()
    await admin_auth.forget_device(db, admin.user_id, body.device_token)
    await admin_auth.audit(db, "logout", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
                           user_agent=admin.user_agent)
    await db.commit()


# ── data ─────────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def dashboard(
    admin: CurrentAdmin,
    db: CoreSession,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> dict[str, Any]:
    """Usage facts for the period (default: the last 30 Bangkok days)."""
    end = date_to or metrics.today_bangkok()
    start = date_from or end - timedelta(days=29)
    try:
        period = metrics.make_period(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    data = await metrics.dashboard(db, period)
    config = await load_cost_config(db)
    source, prices = await current_prices(db, _optional_stripe())
    data["cost_config"] = config.model_dump(mode="json")
    data["model_defaults"] = {
        m["model"]: default_model_price(m["model"]).model_dump() for m in data["models_seen"]
    }
    data["stt_defaults"] = known_stt_prices()
    data["rate_card"] = rate_card.describe()
    quote = await fx.current_usd_thb(db)
    data["fx"] = {"usd_thb": quote.usd_thb, "source": quote.source}
    data["billing_config"] = billing_cfg.view(await billing_cfg.load(db))
    data["circuit_breaker"] = await guard.status()
    data["estimate_accuracy"] = await accuracy.estimate_accuracy(db, period.start_utc, period.end_utc)
    data["prices"] = {"source": source, "satang": prices, "billing_enabled": billing_enabled()}
    data["plan_values"] = list(PLAN_VALUES)
    data["paid_tiers"] = [p.tier for p in catalog.PAID_PLANS]
    data["admin_user_id"] = admin.user_id
    return data


@router.get("/users/{user_id}")
async def user_detail(user_id: int, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้")
    detail = await metrics.user_detail(db, user_id)
    account = await get_account(db, user_id)
    detail["subscription"] = {
        "status": account.status if account else None,
        "live": catalog.is_live(account.status) if account else False,
        "current_period_end": account.current_period_end.isoformat() if account and account.current_period_end else None,
    }
    now = datetime.now(UTC)
    detail["limits"] = metrics.window_facts(user, await get_usage_account(db, user_id), now)
    detail["wallet"] = await wallet.summary(db, user_id, now)
    detail["runs"] = await accuracy.recent_runs(db, user_id)
    detail["estimate_accuracy"] = await accuracy.estimate_accuracy(
        db, now - timedelta(days=90), now + timedelta(seconds=1), user_id
    )
    detail["failed_runs_30d"] = await accuracy.refunded_summary(db, user_id, now - timedelta(days=30))
    return detail


@router.get("/audit")
async def audit_log(
    admin: CurrentAdmin, db: CoreSession, limit: Annotated[int, Query(ge=1, le=200)] = 50
) -> list[dict[str, Any]]:
    rows = (
        await db.execute(select(AdminAuditEvent).order_by(AdminAuditEvent.id.desc()).limit(limit))
    ).scalars().all()
    return [
        {
            "id": r.id, "action": r.action, "email": r.email, "actor_user_id": r.actor_user_id,
            "target_user_id": r.target_user_id, "ip": r.ip, "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


# ── user actions ─────────────────────────────────────────────────────────────

@router.patch("/users/{user_id}/plan", response_model=UserActionOut)
async def set_plan(user_id: int, body: PlanIn, admin: CurrentAdmin, db: CoreSession) -> UserActionOut:
    """Set the plan every limit reads. A live Stripe subscription is re-mirrored
    by its next webhook — except onto `enterprise`, which Stripe never overrides."""
    user = await _target(db, user_id)
    before = str(user.plan)
    account = await get_account(db, user_id)
    user.plan = body.plan
    await admin_auth.audit(
        db, "plan_change", actor_user_id=admin.user_id, email=str(admin.user.email), target_user_id=user_id,
        ip=admin.ip, user_agent=admin.user_agent,
        detail={"before": before, "after": body.plan,
                "live_subscription": bool(account and catalog.is_live(account.status))},
    )
    await db.commit()
    return _action_out(user)


@router.post("/users/{user_id}/quota-reset", response_model=UserActionOut)
async def reset_quota(user_id: int, admin: CurrentAdmin, db: CoreSession) -> UserActionOut:
    """Every window (5-hour, weekly, monthly) starts over at the user's next
    use. Kept as the "reset all" alias of ``window-reset``."""
    user = await _target(db, user_id)
    before = await runs.reset_windows(db, user_id, ("five_hour", "weekly", "monthly"))
    user.usage_reset_at = datetime.now(UTC)
    await admin_auth.audit(
        db, "quota_reset", actor_user_id=admin.user_id, email=str(admin.user.email), target_user_id=user_id,
        ip=admin.ip, user_agent=admin.user_agent, detail={"windows": before},
    )
    await db.commit()
    return _action_out(user)


@router.post("/users/{user_id}/window-reset")
async def reset_window(user_id: int, body: WindowResetIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """One window (5-hour / weekly / monthly) starts over at the user's next
    use. Open reservations stay held. Audited with the tokens it cleared."""
    user = await _target(db, user_id)
    before = await runs.reset_windows(db, user_id, (body.window,))
    user.usage_reset_at = datetime.now(UTC)
    await admin_auth.audit(
        db, "window_reset", actor_user_id=admin.user_id, email=str(admin.user.email), target_user_id=user_id,
        ip=admin.ip, user_agent=admin.user_agent, detail={"window": body.window, "before": before[body.window]},
    )
    await db.commit()
    return metrics.window_facts(user, await get_usage_account(db, user_id), datetime.now(UTC))


@router.post("/users/{user_id}/wallet-adjust")
async def adjust_wallet(user_id: int, body: WalletAdjustIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """Credit (a 12-month ``admin`` lot) or debit a user's top-up balance."""
    await _target(db, user_id)
    if body.amount_satang == 0:
        raise HTTPException(status_code=422, detail="จำนวนเงินต้องไม่เป็นศูนย์")
    before = await wallet.balance(db, user_id)
    applied = await wallet.adjust(db, user_id, body.amount_satang, actor_user_id=admin.user_id, note=body.note)
    after = await wallet.balance(db, user_id)
    await admin_auth.audit(
        db, "wallet_adjust", actor_user_id=admin.user_id, email=str(admin.user.email), target_user_id=user_id,
        ip=admin.ip, user_agent=admin.user_agent,
        detail={"requested_satang": body.amount_satang, "applied_satang": applied, "before_satang": before,
                "after_satang": after, "note": body.note},
    )
    await db.commit()
    return await wallet.summary(db, user_id)


@router.patch("/users/{user_id}/active", response_model=UserActionOut)
async def set_active(user_id: int, body: ActiveIn, admin: CurrentAdmin, db: CoreSession) -> UserActionOut:
    """Deactivating signs the account out everywhere at once: every web/desktop
    token (token_version bump) and every admin session and device."""
    if user_id == admin.user_id and not body.active:
        raise HTTPException(status_code=409, detail="ปิดการใช้งานบัญชีของตัวเองไม่ได้")
    user = await _target(db, user_id)
    before = bool(user.is_active)
    if before and not body.active and user.is_admin:
        others = (
            await db.execute(
                select(func.count(User.id)).where(
                    User.is_admin.is_(True), User.is_active.is_(True), User.id != user_id
                )
            )
        ).scalar_one()
        if int(others) == 0:
            raise HTTPException(status_code=409, detail="ปิดผู้ดูแลระบบคนสุดท้ายที่ยังใช้งานอยู่ไม่ได้")
    if before != body.active:
        user.is_active = body.active
        if not body.active:
            new_version = (
                await db.execute(
                    update(User)
                    .where(User.id == user_id)
                    .values(token_version=User.token_version + 1)
                    .returning(User.token_version)
                    .execution_options(synchronize_session=False)
                )
            ).scalar_one()
            set_committed_value(user, "token_version", new_version)
            await admin_auth.revoke_sessions_and_devices(db, user_id)
            await db.execute(
                update(AdminLoginChallenge)
                .where(AdminLoginChallenge.user_id == user_id, AdminLoginChallenge.used_at.is_(None))
                .values(used_at=admin_auth.now())
            )
        await admin_auth.audit(
            db, "account_activate" if body.active else "account_deactivate", actor_user_id=admin.user_id,
            email=str(admin.user.email), target_user_id=user_id, ip=admin.ip, user_agent=admin.user_agent,
            detail={"before": before, "after": body.active},
        )
    await db.commit()
    return _action_out(user)


# ── settings ─────────────────────────────────────────────────────────────────

@router.get("/cost-config", response_model=CostConfig)
async def get_cost_config(admin: CurrentAdmin, db: CoreSession) -> CostConfig:
    return await load_cost_config(db)


@router.put("/cost-config", response_model=CostConfig)
async def put_cost_config(body: CostConfig, admin: CurrentAdmin, db: CoreSession) -> CostConfig:
    before = await load_cost_config(db)
    await save_cost_config(db, body, admin.user_id)
    # This process prices new usage rows from it right away; the worker's
    # cache lapses within a minute (packages/billing/vendor_cost.py).
    vendor_cost.invalidate_cache()
    await admin_auth.audit(
        db, "cost_config_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
        user_agent=admin.user_agent,
        detail={"before": before.model_dump(mode="json"), "after": body.model_dump(mode="json")},
    )
    await db.commit()
    return body


async def _fx_view(db: AsyncSession) -> dict[str, Any]:
    quote = await fx.resolve_usd_thb(db)
    latest = await fx.latest_fetched(db)
    return {
        "usd_thb": quote.usd_thb,
        "source": quote.source,
        "override": await fx.load_override(db),
        "fetched": {
            "usd_thb": float(latest.usd_thb), "date": latest.rate_date.isoformat(), "source": latest.source,
        } if latest else None,
        "history": await fx.history(db),
        "band": list(fx.SANE_BAND),
    }


@router.get("/fx")
async def get_fx(admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """The USD→THB rate vendor cost is priced with, where it came from, 30 days of history."""
    return await _fx_view(db)


@router.put("/fx")
async def put_fx(body: FxIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """Set or clear the manual override (it always wins over the fetched rate)."""
    before = await fx.load_override(db)
    await fx.save_override(db, body.usd_thb, admin.user_id)
    await admin_auth.audit(
        db, "fx_override_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
        user_agent=admin.user_agent, detail={"before": before, "after": body.usd_thb},
    )
    await db.commit()
    vendor_cost.invalidate_cache()
    return await _fx_view(db)


@router.post("/fx/refresh")
async def refresh_fx_now(admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """Fetch today's rate now instead of waiting for the daily job."""
    quote = await fx.refresh_fx(db)
    if quote is None:
        raise HTTPException(status_code=502, detail="ดึงอัตราแลกเปลี่ยนไม่สำเร็จ ลองใหม่ภายหลัง")
    vendor_cost.invalidate_cache()
    return await _fx_view(db)


@router.get("/reconciliation")
async def get_reconciliation(
    admin: CurrentAdmin, db: CoreSession, month: Annotated[str | None, Query()] = None
) -> dict[str, Any]:
    """Recorded vendor cost vs the invoice, per vendor, for a UTC month (default: this one)."""
    month = month or datetime.now(UTC).strftime("%Y-%m")
    try:
        return await recon.reconciliation(db, month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.put("/reconciliation/{month}")
async def put_reconciliation(month: str, body: InvoiceIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """Store what a vendor actually invoiced for the month."""
    try:
        before = await recon.save_invoice(db, month, body.vendor, body.amount_thb, body.note, admin.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    await admin_auth.audit(
        db, "vendor_invoice_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
        user_agent=admin.user_agent,
        detail={"month": month, "vendor": body.vendor, "before": before,
                "after": {"amount_thb": body.amount_thb, "note": body.note}},
    )
    await db.commit()
    return await recon.reconciliation(db, month)


@router.get("/estimate-accuracy")
async def get_estimate_accuracy(
    admin: CurrentAdmin,
    db: CoreSession,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    user_id: Annotated[int | None, Query()] = None,
) -> dict[str, Any]:
    """Estimate vs actual over paid runs (default: the last 30 Bangkok days),
    for everyone or one user."""
    end = date_to or metrics.today_bangkok()
    start = date_from or end - timedelta(days=29)
    try:
        period = metrics.make_period(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return await accuracy.estimate_accuracy(db, period.start_utc, period.end_utc, user_id)


@router.get("/billing-config")
async def get_billing_config(admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    """Reference cost + sell price per 1M (display/margin only), the top-up
    price and the rate card (read-only: charges come from code)."""
    return billing_cfg.view(await billing_cfg.load(db))


@router.put("/billing-config")
async def put_billing_config(body: billing_cfg.BillingConfig, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    before = await billing_cfg.load(db)
    await billing_cfg.save(db, body, admin.user_id)
    await admin_auth.audit(
        db, "billing_config_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
        user_agent=admin.user_agent, detail={"before": before.model_dump(), "after": body.model_dump()},
    )
    await db.commit()
    return billing_cfg.view(body)


@router.get("/circuit-breaker")
async def get_circuit_breaker(admin: CurrentAdmin) -> dict[str, Any]:
    """The daily AI spend cap, today's spend (UTC day) and whether it tripped."""
    return await guard.status()


@router.put("/circuit-breaker")
async def put_circuit_breaker(body: BreakerIn, admin: CurrentAdmin, db: CoreSession) -> dict[str, Any]:
    before = await guard.load_breaker(db)
    after = await guard.save_breaker(db, body.model_dump(), admin.user_id)
    await admin_auth.audit(
        db, "circuit_breaker_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
        user_agent=admin.user_agent, detail={"before": before, "after": after},
    )
    await db.commit()
    return await guard.status()


@router.get("/plan-prices")
async def get_plan_prices(admin: CurrentAdmin, db: CoreSession, client: OptionalStripe) -> dict[str, Any]:
    source, prices = await current_prices(db, client)
    return {"source": source, "billing_enabled": client is not None, "satang": prices, "max_thb": MAX_PRICE_THB}


@router.put("/plan-prices")
async def put_plan_prices(
    body: PricesIn, admin: CurrentAdmin, db: CoreSession, client: OptionalStripe
) -> dict[str, Any]:
    try:
        changes = await change_prices(db, client, {str(k): v for k, v in body.prices.items()}, admin.user_id)
    except PriceChangeError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None
    for c in changes:
        await admin_auth.audit(
            db, "price_change", actor_user_id=admin.user_id, email=str(admin.user.email), ip=admin.ip,
            user_agent=admin.user_agent,
            detail={"tier": c.tier, "before": c.before, "after": c.after, "stripe_price_id": c.stripe_price_id,
                    "source": "stripe" if client is not None else "local"},
        )
    await db.commit()
    source, prices = await current_prices(db, client)
    return {
        "source": source,
        "billing_enabled": client is not None,
        "satang": prices,
        "changed": [c.tier for c in changes],
        "max_thb": MAX_PRICE_THB,
    }
