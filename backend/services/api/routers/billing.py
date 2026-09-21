"""Billing endpoints (Stripe subscriptions). See docs/billing-stripe.md.

GET  /billing/plans        public — paid plans with live (or mock) amounts
GET  /billing/me           the caller's plan + subscription mirror
POST /billing/checkout     Stripe Checkout URL for a first subscription
POST /billing/change-plan  customer-portal deep link confirming a plan switch
POST /billing/cancel       end the subscription at the end of the paid period
POST /billing/resume       undo a scheduled cancellation
POST /billing/portal       the customer portal (invoices, card, plan)
POST /billing/webhook      Stripe only — signature-verified

With STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET unset, everything that needs
Stripe answers 503 with the reason; /plans serves the mock catalog and /me
reports `billing_enabled: false`.
"""

import hashlib
from datetime import datetime
from typing import Annotated, Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import service, webhooks
from packages.billing.client import billing_config_problem, billing_enabled, get_stripe_client
from packages.billing.service import BillingError, BillingState
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from services.api.deps import CurrentUser, core_session

log = get_logger(__name__)

router = APIRouter(prefix="/billing", tags=["billing"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]


# ── dependencies ──────────────────────────────────────────────────────────────

def stripe_client() -> stripe.StripeClient:
    """The StripeClient, or 503 naming what is missing. Overridden in tests."""
    problem = billing_config_problem()
    if problem:
        raise HTTPException(status_code=503, detail=problem)
    return get_stripe_client()


def optional_stripe_client() -> stripe.StripeClient | None:
    """For the public price list, which degrades to the mock catalog instead of 503."""
    return get_stripe_client() if billing_enabled() else None


StripeDep = Annotated[stripe.StripeClient, Depends(stripe_client)]
OptionalStripeDep = Annotated[stripe.StripeClient | None, Depends(optional_stripe_client)]


# ── schemas ───────────────────────────────────────────────────────────────────

class PlanOut(BaseModel):
    tier: str
    lookup_key: str
    interval: Literal["month"]
    unit_amount: int  # satang (THB x 100)


class PlansOut(BaseModel):
    source: Literal["stripe", "mock"]
    currency: Literal["thb"]
    plans: list[PlanOut]


class PaymentMethodOut(BaseModel):
    brand: str
    last4: str


class BillingMeOut(BaseModel):
    plan: str
    status: str | None
    lookup_key: str | None
    current_period_end: datetime | None
    #: True while a live subscription is scheduled to end (access continues
    #: until current_period_end, then the plan returns to free).
    cancel_at_period_end: bool
    payment_method: PaymentMethodOut | None
    billing_enabled: bool


class LookupKeyIn(BaseModel):
    lookup_key: str


class UrlOut(BaseModel):
    url: str


def _me_out(state: BillingState) -> BillingMeOut:
    pm = state.payment_method
    return BillingMeOut(
        plan=state.plan,
        status=state.status,
        lookup_key=state.lookup_key,
        current_period_end=state.current_period_end,
        cancel_at_period_end=state.cancel_at_period_end,
        payment_method=PaymentMethodOut(brand=pm["brand"], last4=pm["last4"]) if pm else None,
        billing_enabled=state.billing_enabled,
    )


def _refusal(exc: BillingError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("/plans", response_model=PlansOut)
async def list_plans(client: OptionalStripeDep) -> PlansOut:
    """The paid plans. Amounts come live from Stripe by lookup key (cached ~10
    min) when billing is configured, else from the mock catalog."""
    key = (get_settings().stripe_secret_key or "").strip() if client is not None else ""
    cache_key = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    plans = await service.list_plans(client, cache_key=cache_key)
    return PlansOut(
        source="stripe" if plans.source == "stripe" else "mock",
        currency="thb",
        plans=[
            PlanOut(tier=p.tier, lookup_key=p.lookup_key, interval="month", unit_amount=p.unit_amount)
            for p in plans.plans
        ],
    )


@router.get("/me", response_model=BillingMeOut)
async def billing_me(auth: CurrentUser, session: CoreSession) -> BillingMeOut:
    """The caller's plan and subscription, from the database (kept current by the webhook)."""
    state = await service.billing_state(session, auth.user, enabled=billing_enabled())
    return _me_out(state)


@router.post("/checkout", response_model=UrlOut)
async def checkout(
    body: LookupKeyIn, auth: CurrentUser, client: StripeDep, session: CoreSession
) -> UrlOut:
    """A Stripe Checkout URL for the plan. 409 when a live subscription exists
    (use /billing/change-plan), 422 for an unknown lookup key."""
    try:
        url = await service.create_checkout_session(
            session, client, get_settings(), auth.user, body.lookup_key
        )
    except BillingError as exc:
        raise _refusal(exc) from None
    return UrlOut(url=url)


@router.post("/change-plan", response_model=UrlOut)
async def change_plan(
    body: LookupKeyIn, auth: CurrentUser, client: StripeDep, session: CoreSession
) -> UrlOut:
    """A customer-portal link where the user confirms the switch. 409 without a
    live subscription (or already on that plan / a change already scheduled)."""
    try:
        url = await service.create_change_plan_session(
            session, client, get_settings(), auth.user, body.lookup_key
        )
    except BillingError as exc:
        raise _refusal(exc) from None
    return UrlOut(url=url)


@router.post("/cancel", response_model=BillingMeOut)
async def cancel(auth: CurrentUser, client: StripeDep, session: CoreSession) -> BillingMeOut:
    """Cancel at the end of the paid period (idempotent). 409 without a live subscription."""
    try:
        await service.cancel_subscription(session, client, auth.user)
    except BillingError as exc:
        raise _refusal(exc) from None
    return _me_out(await service.billing_state(session, auth.user, enabled=True))


@router.post("/resume", response_model=BillingMeOut)
async def resume(auth: CurrentUser, client: StripeDep, session: CoreSession) -> BillingMeOut:
    """Undo a scheduled cancellation. 409 when nothing is scheduled to end."""
    try:
        await service.resume_subscription(session, client, auth.user)
    except BillingError as exc:
        raise _refusal(exc) from None
    return _me_out(await service.billing_state(session, auth.user, enabled=True))


@router.post("/portal", response_model=UrlOut)
async def portal(auth: CurrentUser, client: StripeDep, session: CoreSession) -> UrlOut:
    """The Stripe customer portal. 409 before the first checkout (no customer yet)."""
    try:
        url = await service.create_portal_session(session, client, get_settings(), auth.user)
    except BillingError as exc:
        raise _refusal(exc) from None
    return UrlOut(url=url)


@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(request: Request, client: StripeDep, session: CoreSession) -> dict[str, str]:
    """Stripe → us. Verified against the RAW body; 400 for a bad signature,
    5xx when processing fails (Stripe retries), 200 otherwise — including for
    duplicates and event types this integration ignores."""
    payload = await request.body()
    secret = (get_settings().stripe_webhook_secret or "").strip()
    try:
        event = webhooks.construct_event(payload, request.headers.get("stripe-signature"), secret)
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="invalid signature") from None
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid payload") from None

    try:
        outcome = await webhooks.handle_event(session, client, event)
    except (stripe.StripeError, SQLAlchemyError) as exc:
        await session.rollback()
        log.error(
            "stripe_webhook_failed",
            event_id=event.id,
            event_type=event.type,
            error_type=type(exc).__name__,
            error=str(exc) if isinstance(exc, stripe.StripeError) else None,
        )
        raise HTTPException(status_code=500, detail="event not processed; it will be retried") from None

    log.info("stripe_webhook", event_id=event.id, event_type=event.type, outcome=outcome)
    return {"status": outcome}
