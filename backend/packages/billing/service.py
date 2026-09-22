"""Billing operations, and the Stripe → database sync every one of them ends in.

Stripe is the source of truth. Nothing here trusts an event payload or a
redirect: every state change re-reads the customer's subscriptions from Stripe
while holding the ``billing_accounts`` row lock, then mirrors them into that row
and ``users.plan``. The lock is taken BEFORE the read, so of two concurrent syncs
the one that commits last also read last — an older snapshot can never
overwrite a newer one.

User-facing operations raise ``BillingError`` (the HTTP status the API should
answer). The sync itself lets ``stripe.StripeError`` propagate, so the webhook
answers 5xx and Stripe retries.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import stripe
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import catalog
from packages.billing.catalog import PaidPlan
from packages.billing.objects import field, id_of, items_of, metadata_value
from packages.core.logging import get_logger
from packages.db.models.billing import BillingAccount
from packages.db.models.core_auth import User

if TYPE_CHECKING:
    from stripe.params import CustomerCreateParams, SubscriptionUpdateParams
    from stripe.params.billing_portal import SessionCreateParams as PortalSessionCreateParams
    from stripe.params.checkout import SessionCreateParams as CheckoutSessionCreateParams

    from packages.core.settings import Settings

log = get_logger(__name__)

ENTERPRISE_TIER = "enterprise"

_PLANS_TTL_SEC = 600  # "cached about 10 minutes"
_PLANS_RETRY_SEC = 60  # after a failure or a half-seeded catalog


class BillingError(Exception):
    """An expected refusal, carrying the HTTP status the API should answer."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class BillingState:
    """What GET /billing/me reports — read from the database only."""

    plan: str
    status: str | None
    lookup_key: str | None
    current_period_end: datetime | None
    cancel_at_period_end: bool
    payment_method: dict[str, str] | None
    billing_enabled: bool


@dataclass(frozen=True)
class PlanPrice:
    tier: str
    lookup_key: str
    unit_amount: int  # satang


@dataclass(frozen=True)
class PlanList:
    source: str  # "stripe" | "mock"
    plans: tuple[PlanPrice, ...]


# ── reading subscriptions ────────────────────────────────────────────────────

def tier_for_price(price: Any) -> str | None:
    """The paid tier a Stripe price belongs to, or None when it is not one of ours.

    The lookup key first; then the seed's ``noey_tier`` metadata, which a price
    keeps after its lookup key moved to a newer price (a grandfathered sub).
    """
    plan = catalog.plan_for_lookup_key(field(price, "lookup_key"))
    if plan is not None:
        return plan.tier
    tier = metadata_value(price, catalog.TIER_METADATA_KEY)
    return tier if catalog.plan_for_tier(tier) is not None else None


def tier_for_subscription(sub: Any) -> str | None:
    items = items_of(sub)
    return tier_for_price(field(items[0], "price")) if items else None


def plan_for_subscription(sub: Any | None) -> str | None:
    """The `users.plan` value a subscription means (the owner's rule).

    live (active / trialing / past_due) → its tier; anything else → free.
    None when it is live but on a price that maps to no tier: the caller must
    not guess — a paying customer silently demoted to free is worse than a
    logged error and an unchanged plan.
    """
    if sub is None or not catalog.is_live(field(sub, "status")):
        return catalog.FREE_TIER
    return tier_for_subscription(sub)


def _scheduled_to_end(sub: Any) -> bool:
    # Classic billing mode sets cancel_at_period_end; flexible mode (the
    # default since API 2025-09-30.clover, and what the portal uses) sets
    # cancel_at and leaves cancel_at_period_end false.
    return bool(field(sub, "cancel_at_period_end") or field(sub, "cancel_at"))


def _period_end(sub: Any) -> datetime | None:
    # Since API 2025-03-31.basil the period lives on each item, not the subscription.
    ends = [e for e in (field(i, "current_period_end") for i in items_of(sub)) if isinstance(e, int)]
    return datetime.fromtimestamp(max(ends), tz=UTC) if ends else None


def _card_of(payment_method: Any) -> tuple[str | None, str | None]:
    if field(payment_method, "type") != "card":
        return None, None
    card = field(payment_method, "card")
    brand, last4 = field(card, "brand"), field(card, "last4")
    return (str(brand) if brand else None, str(last4) if last4 else None)


def _choose_subscription(subs: Sequence[Any], customer_id: str) -> Any | None:
    """The one subscription the account mirrors.

    A live one if there is any (the highest tier, then the newest); otherwise
    the newest, so a cancellation still shows as `canceled`.
    """
    live = [s for s in subs if catalog.is_live(field(s, "status"))]
    if len(live) > 1:
        log.warning(
            "billing_multiple_live_subscriptions",
            customer=customer_id,
            subscriptions=[field(s, "id") for s in live],
        )
    pool = live or list(subs)
    if not pool:
        return None
    return max(
        pool,
        key=lambda s: (
            catalog.tier_rank(tier_for_subscription(s)) if live else 0,
            field(s, "created") or 0,
        ),
    )


# ── database ─────────────────────────────────────────────────────────────────

async def get_account(session: AsyncSession, user_id: int) -> BillingAccount | None:
    found = await session.execute(select(BillingAccount).where(BillingAccount.user_id == user_id))
    return found.scalar_one_or_none()


async def lock_account(session: AsyncSession, user_id: int) -> BillingAccount | None:
    stmt = (
        select(BillingAccount)
        .where(BillingAccount.user_id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def lock_account_by_customer(session: AsyncSession, customer_id: str) -> BillingAccount | None:
    stmt = (
        select(BillingAccount)
        .where(BillingAccount.stripe_customer_id == customer_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def billing_state(session: AsyncSession, user: User, *, enabled: bool) -> BillingState:
    account = await get_account(session, int(user.id))
    payment_method = None
    if account is not None and account.pm_brand and account.pm_last4:
        payment_method = {"brand": account.pm_brand, "last4": account.pm_last4}
    return BillingState(
        plan=str(user.plan or catalog.FREE_TIER),
        status=account.status if account else None,
        lookup_key=account.price_lookup_key if account else None,
        current_period_end=account.current_period_end if account else None,
        cancel_at_period_end=bool(account.cancel_at_period_end) if account else False,
        payment_method=payment_method,
        billing_enabled=enabled,
    )


# ── the sync ─────────────────────────────────────────────────────────────────

async def fetch_subscriptions(client: stripe.StripeClient, customer_id: str) -> list[Any]:
    """Every subscription of the customer, newest first, default payment method expanded."""
    try:
        page = await client.v1.subscriptions.list_async(
            {
                "customer": customer_id,
                "status": "all",
                "limit": 100,
                "expand": ["data.default_payment_method"],
            }
        )
    except stripe.InvalidRequestError as exc:
        if exc.code == "resource_missing":  # the customer was deleted in Stripe
            log.warning("billing_customer_missing", customer=customer_id)
            return []
        raise
    return list(page.data)


async def _payment_method_for(client: stripe.StripeClient, sub: Any, customer_id: str) -> Any:
    """The subscription's own default payment method, else the customer's.

    The portal's "update payment method" sets the CUSTOMER default and may
    clear the subscription's override, so both places have to be read.
    """
    pm = field(sub, "default_payment_method")
    if pm is not None and not isinstance(pm, str):
        return pm
    customer = await client.v1.customers.retrieve_async(
        customer_id, {"expand": ["invoice_settings.default_payment_method"]}
    )
    found = field(field(customer, "invoice_settings"), "default_payment_method")
    return None if isinstance(found, str) else found


async def _apply(
    client: stripe.StripeClient,
    account: BillingAccount,
    user: User,
    sub: Any | None,
) -> None:
    """Mirror one subscription (or none) into the account row and `users.plan`."""
    live = sub is not None and catalog.is_live(field(sub, "status"))
    if sub is None:
        account.stripe_subscription_id = None
        account.price_lookup_key = None
        account.status = None
        account.current_period_end = None
        account.cancel_at_period_end = False
        account.pm_brand = account.pm_last4 = None
    else:
        tier = tier_for_subscription(sub)
        plan = catalog.plan_for_tier(tier)
        items = items_of(sub)
        raw_key = field(field(items[0], "price"), "lookup_key") if items else None
        account.stripe_subscription_id = field(sub, "id")
        account.price_lookup_key = plan.lookup_key if plan else raw_key
        account.status = field(sub, "status")
        account.current_period_end = _period_end(sub)
        account.cancel_at_period_end = live and _scheduled_to_end(sub)
        pm = await _payment_method_for(client, sub, account.stripe_customer_id) if live else None
        account.pm_brand, account.pm_last4 = _card_of(pm)

    new_plan = plan_for_subscription(sub)
    if new_plan is None:
        log.error(
            "billing_unknown_price",
            user_id=user.id,
            subscription=field(sub, "id"),
            hint="the subscribed price has neither a catalog lookup key nor noey_tier metadata",
        )
        return
    if user.plan == ENTERPRISE_TIER:
        # Admin-granted; Stripe never overrides it (docs/billing-stripe.md).
        return
    if user.plan != new_plan:
        log.info("billing_plan_changed", user_id=user.id, old=user.plan, new=new_plan)
        user.plan = new_plan


async def sync_account(
    session: AsyncSession,
    client: stripe.StripeClient,
    account: BillingAccount,
    user: User,
) -> Any | None:
    """Re-read the customer's subscriptions and mirror them. The caller holds the
    row lock (``lock_account*``) and commits. Returns the subscription mirrored."""
    subs = await fetch_subscriptions(client, account.stripe_customer_id)
    chosen = _choose_subscription(subs, account.stripe_customer_id)
    await _apply(client, account, user, chosen)
    await session.flush()
    return chosen


# ── user-facing operations ───────────────────────────────────────────────────

@asynccontextmanager
async def _stripe_errors(action: str) -> AsyncIterator[None]:
    """Translate Stripe failures of a user-facing call into BillingError."""
    try:
        yield
    except (stripe.AuthenticationError, stripe.PermissionError) as exc:
        # A wrong key, or a restricted key missing a permission — the message
        # names the resource, which is exactly what the owner needs.
        log.error("stripe_access_denied", action=action, error=str(exc))
        raise BillingError(503, "billing is misconfigured on this server") from exc
    except stripe.StripeError as exc:
        log.error(
            "stripe_error",
            action=action,
            error_type=type(exc).__name__,
            code=exc.code,
            error=str(exc),
        )
        raise BillingError(
            502, "the payment provider could not complete the request — please try again"
        ) from exc


def _site(settings: Settings) -> str:
    return settings.site_url.strip().rstrip("/")


def _price_is_usable(price: Any) -> bool:
    recurring = field(price, "recurring")
    return (
        field(price, "currency") == catalog.CURRENCY
        and field(recurring, "interval") == catalog.INTERVAL
        and isinstance(field(price, "unit_amount"), int)
    )


async def _active_price(client: stripe.StripeClient, plan: PaidPlan) -> Any:
    """The price currently holding the plan's lookup key — read fresh, never cached,
    so a checkout can never use a price that was just replaced."""
    page = await client.v1.prices.list_async(
        {"lookup_keys": [plan.lookup_key], "active": True, "limit": 1}
    )
    price = page.data[0] if page.data else None
    if price is None or not _price_is_usable(price):
        log.error(
            "billing_price_missing",
            lookup_key=plan.lookup_key,
            hint="run scripts/stripe_seed.py against this Stripe account",
        )
        raise BillingError(503, f"the {plan.tier} plan is not available for purchase yet")
    return price


def _customer_idempotency_key(user: User) -> str:
    # Same user + same email → same key, so two simultaneous first checkouts
    # get ONE customer back from Stripe (keys live 24 h).
    digest = hashlib.sha256(str(user.email).encode("utf-8")).hexdigest()[:12]
    return f"noey-customer-{user.id}-{digest}"


async def ensure_customer(
    session: AsyncSession, client: stripe.StripeClient, user: User
) -> BillingAccount:
    """The user's billing row, creating the Stripe customer first if needed.

    COMMITS before returning: the customer id has to be stored before any
    Checkout Session exists, so every event resolves through our database.

    Two simultaneous first checkouts (a double click) both miss the row; the
    idempotency key makes Stripe hand both the SAME customer, and the insert
    below keeps one row. No lock on `users` here on purpose: every billing
    path locks `billing_accounts` first and updates `users` second, and taking
    them in the other order here could deadlock against the webhook.
    """
    account = await lock_account(session, int(user.id))
    if account is None:
        params: CustomerCreateParams = {
            "email": str(user.email),
            "metadata": {"user_id": str(user.id)},
        }
        if user.display_name:
            params["name"] = user.display_name
        customer = await client.v1.customers.create_async(
            params, {"idempotency_key": _customer_idempotency_key(user)}
        )
        await session.execute(
            pg_insert(BillingAccount)
            .values(user_id=int(user.id), stripe_customer_id=customer.id)
            .on_conflict_do_nothing(index_elements=[BillingAccount.user_id])
        )
        account = await lock_account(session, int(user.id))
        if account is None:  # pragma: no cover — the insert above guarantees a row
            raise RuntimeError("billing account vanished right after insert")
        if account.stripe_customer_id != customer.id:
            log.warning(
                "billing_orphan_customer", user_id=user.id, orphan=customer.id,
                kept=account.stripe_customer_id,
            )
        log.info("billing_customer_created", user_id=user.id, customer=account.stripe_customer_id)
    await session.commit()
    return account


async def _live_subscription(
    session: AsyncSession, client: stripe.StripeClient, user: User
) -> tuple[BillingAccount | None, Any | None]:
    """Re-sync the caller's account and return (account, its live subscription or None).

    Commits the sync, whatever the caller does next.
    """
    account = await lock_account(session, int(user.id))
    if account is None:
        return None, None
    sub = await sync_account(session, client, account, user)
    await session.commit()
    return account, (sub if sub is not None and catalog.is_live(field(sub, "status")) else None)


async def _expire_open_checkouts(client: stripe.StripeClient, customer_id: str) -> None:
    """Expire the customer's still-open Checkout Sessions (a second tab, a double
    click) so at most one can ever turn into a subscription."""
    page = await client.v1.checkout.sessions.list_async(
        {"customer": customer_id, "status": "open", "limit": 20}
    )
    for stale in page.data:
        try:
            await client.v1.checkout.sessions.expire_async(stale.id)
        except stripe.InvalidRequestError as exc:  # completed or expired meanwhile
            log.info("billing_checkout_expire_skipped", session=stale.id, code=exc.code)


async def create_checkout_session(
    session: AsyncSession,
    client: stripe.StripeClient,
    settings: Settings,
    user: User,
    lookup_key: str,
) -> str:
    """A Stripe Checkout URL subscribing the user to the plan behind ``lookup_key``."""
    plan = catalog.plan_for_lookup_key(lookup_key)
    if plan is None:
        raise BillingError(422, f"unknown plan: {lookup_key!r}")
    if user.plan == ENTERPRISE_TIER:
        raise BillingError(409, "this account's plan is managed by an administrator")

    async with _stripe_errors("checkout"):
        await ensure_customer(session, client, user)
        account, live = await _live_subscription(session, client, user)
        if account is None:  # pragma: no cover — ensure_customer just created it
            raise RuntimeError("billing account missing after ensure_customer")
        if live is not None:
            raise BillingError(
                409, "this account already has an active subscription — change the plan instead"
            )
        price = await _active_price(client, plan)
        await _expire_open_checkouts(client, account.stripe_customer_id)

        site = _site(settings)
        params: CheckoutSessionCreateParams = {
            "mode": "subscription",
            "customer": account.stripe_customer_id,
            "client_reference_id": str(user.id),
            "line_items": [{"price": price.id, "quantity": 1}],
            "subscription_data": {"metadata": {"user_id": str(user.id)}},
            "metadata": {"user_id": str(user.id)},
            "allow_promotion_codes": True,
            "success_url": f"{site}/checkout/success?session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{site}/pricing?checkout=canceled",
            "integration_identifier": catalog.INTEGRATION_IDENTIFIER,
        }
        # No payment_method_types: Stripe picks eligible methods dynamically
        # from the Dashboard settings (card-only is a Dashboard choice).
        if settings.billing_automatic_tax:
            params["automatic_tax"] = {"enabled": True}
            # Our customers are created without an address; let Checkout save
            # the one it collects so the tax location resolves.
            params["customer_update"] = {"address": "auto", "name": "auto"}
        checkout = await client.v1.checkout.sessions.create_async(params)

    log.info("billing_checkout_created", user_id=user.id, lookup_key=plan.lookup_key)
    if not checkout.url:  # pragma: no cover — hosted Checkout always returns one
        raise BillingError(502, "the payment provider returned no checkout page")
    return checkout.url


async def create_change_plan_session(
    session: AsyncSession,
    client: stripe.StripeClient,
    settings: Settings,
    user: User,
    lookup_key: str,
) -> str:
    """A customer-portal deep link where the user confirms switching to ``lookup_key``.

    Stripe shows the proration and takes any payment (3-D Secure included).
    What happens on confirm is the portal configuration's rule — upgrades
    immediately with proration, downgrades at period end (scripts/stripe_seed.py).
    """
    plan = catalog.plan_for_lookup_key(lookup_key)
    if plan is None:
        raise BillingError(422, f"unknown plan: {lookup_key!r}")

    async with _stripe_errors("change_plan"):
        account, sub = await _live_subscription(session, client, user)
        if account is None or sub is None:
            raise BillingError(409, "there is no active subscription to change")
        if tier_for_subscription(sub) == plan.tier:
            raise BillingError(409, "the subscription is already on this plan")
        if field(sub, "schedule"):
            # The portal refuses to update a subscription with a scheduled
            # change (e.g. a downgrade waiting for period end).
            raise BillingError(
                409, "a plan change is already scheduled for the end of this billing period"
            )
        items = items_of(sub)
        if len(items) != 1:
            raise BillingError(409, "this subscription cannot be changed here — use the billing portal")
        price = await _active_price(client, plan)

        site = _site(settings)
        params: PortalSessionCreateParams = {
            "customer": account.stripe_customer_id,
            "return_url": f"{site}/account/billing",
            "flow_data": {
                "type": "subscription_update_confirm",
                "subscription_update_confirm": {
                    "subscription": str(field(sub, "id")),
                    "items": [{"id": str(field(items[0], "id")), "price": price.id, "quantity": 1}],
                },
                "after_completion": {
                    "type": "redirect",
                    "redirect": {"return_url": f"{site}/account/billing?plan_change=done"},
                },
            },
        }
        if settings.stripe_portal_configuration_id:
            params["configuration"] = settings.stripe_portal_configuration_id.strip()
        portal = await client.v1.billing_portal.sessions.create_async(params)

    log.info("billing_change_plan_link", user_id=user.id, target=plan.lookup_key)
    return portal.url


async def _update_and_mirror(
    session: AsyncSession,
    client: stripe.StripeClient,
    account: BillingAccount,
    user: User,
    subscription_id: str,
    params: SubscriptionUpdateParams,
) -> None:
    params["expand"] = ["default_payment_method"]
    updated = await client.v1.subscriptions.update_async(subscription_id, params)
    await _apply(client, account, user, updated)
    await session.commit()


async def cancel_subscription(
    session: AsyncSession, client: stripe.StripeClient, user: User
) -> None:
    """Schedule the live subscription to end at the end of the paid period.

    Access (the tier) stays until then; `customer.subscription.deleted` turns
    the account free. A downgrade already scheduled is dropped — the customer
    asked to leave, not to downgrade first.
    """
    async with _stripe_errors("cancel"):
        account = await lock_account(session, int(user.id))
        sub = await sync_account(session, client, account, user) if account else None
        if account is None or sub is None or not catalog.is_live(field(sub, "status")):
            await session.commit()
            raise BillingError(409, "there is no active subscription to cancel")
        if _scheduled_to_end(sub):
            await session.commit()  # already ending: idempotent
            return
        schedule_id = id_of(field(sub, "schedule"))
        if schedule_id:
            await client.v1.subscription_schedules.release_async(schedule_id)
            log.info("billing_schedule_released", user_id=user.id, schedule=schedule_id)
        mode = field(field(sub, "billing_mode"), "type")
        params: SubscriptionUpdateParams = (
            # Flexible billing mode: what the portal itself does.
            {"cancel_at": "max_period_end"} if mode == "flexible" else {"cancel_at_period_end": True}
        )
        await _update_and_mirror(session, client, account, user, str(field(sub, "id")), params)
    log.info("billing_cancel_scheduled", user_id=user.id)


async def resume_subscription(
    session: AsyncSession, client: stripe.StripeClient, user: User
) -> None:
    """Undo a scheduled cancellation while the period has not ended yet."""
    async with _stripe_errors("resume"):
        account = await lock_account(session, int(user.id))
        sub = await sync_account(session, client, account, user) if account else None
        if account is None or sub is None or not catalog.is_live(field(sub, "status")):
            await session.commit()
            raise BillingError(409, "there is no active subscription to resume")
        if not _scheduled_to_end(sub):
            await session.commit()
            raise BillingError(409, "the subscription is not scheduled to cancel")
        params: SubscriptionUpdateParams = (
            {"cancel_at_period_end": False} if field(sub, "cancel_at_period_end") else {"cancel_at": ""}
        )
        await _update_and_mirror(session, client, account, user, str(field(sub, "id")), params)
    log.info("billing_cancel_undone", user_id=user.id)


async def sync_customer_email(
    session: AsyncSession, client: stripe.StripeClient, user: User
) -> None:
    """Best effort: after a confirmed email change, move the Stripe customer's
    email (where receipts and invoices go) to the account's new address."""
    account = await get_account(session, int(user.id))
    if account is None:
        return
    try:
        await client.v1.customers.update_async(account.stripe_customer_id, {"email": str(user.email)})
    except stripe.StripeError as exc:
        log.warning("billing_customer_email_sync_failed", user_id=user.id, error_type=type(exc).__name__)


async def create_portal_session(
    session: AsyncSession, client: stripe.StripeClient, settings: Settings, user: User
) -> str:
    """The Stripe customer portal: invoices, payment method, plan, cancellation."""
    account = await get_account(session, int(user.id))
    if account is None:
        raise BillingError(409, "there is no billing account yet — subscribe to a plan first")
    params: PortalSessionCreateParams = {
        "customer": account.stripe_customer_id,
        "return_url": f"{_site(settings)}/account/billing",
    }
    if settings.stripe_portal_configuration_id:
        params["configuration"] = settings.stripe_portal_configuration_id.strip()
    async with _stripe_errors("portal"):
        portal = await client.v1.billing_portal.sessions.create_async(params)
    return portal.url


# ── the price list ───────────────────────────────────────────────────────────

MOCK_PLANS = PlanList(
    source="mock",
    plans=tuple(PlanPrice(p.tier, p.lookup_key, p.mock_unit_amount) for p in catalog.PAID_PLANS),
)

_plans_cache: dict[str, tuple[float, PlanList]] = {}
_plans_lock = asyncio.Lock()


def reset_plans_cache() -> None:
    _plans_cache.clear()


async def _fetch_plan_list(client: stripe.StripeClient) -> PlanList | None:
    """Live amounts by lookup key, or None when the catalog is not (fully) seeded."""
    page = await client.v1.prices.list_async(
        {
            "lookup_keys": [p.lookup_key for p in catalog.PAID_PLANS],
            "active": True,
            "limit": len(catalog.PAID_PLANS),
        }
    )
    amounts: dict[str, int] = {}
    for price in page.data:
        amount = field(price, "unit_amount")
        if _price_is_usable(price) and isinstance(amount, int):
            amounts[str(field(price, "lookup_key"))] = amount
    missing = [p.lookup_key for p in catalog.PAID_PLANS if p.lookup_key not in amounts]
    if missing:
        log.warning("billing_prices_missing", lookup_keys=missing, hint="run scripts/stripe_seed.py")
        return None
    return PlanList(
        source="stripe",
        plans=tuple(
            PlanPrice(p.tier, p.lookup_key, amounts[p.lookup_key]) for p in catalog.PAID_PLANS
        ),
    )


def mock_plans(overrides: dict[str, int] | None = None) -> PlanList:
    """The catalog's mock amounts, with any admin-set price in place of its tier's.

    Only used while Stripe is not configured — with Stripe, an admin price edit
    creates a real Stripe Price instead (packages/admin/pricing.py).
    """
    if not overrides:
        return MOCK_PLANS
    return PlanList(
        source="mock",
        plans=tuple(
            PlanPrice(p.tier, p.lookup_key, int(overrides.get(p.tier, p.mock_unit_amount)))
            for p in catalog.PAID_PLANS
        ),
    )


async def list_plans(
    client: stripe.StripeClient | None,
    cache_key: str = "",
    overrides: dict[str, int] | None = None,
) -> PlanList:
    """The paid plans with amounts: live from Stripe (cached ~10 min) or the mock catalog.

    Falls back to the last good Stripe answer, else the mock, when Stripe is
    unreachable — a public pricing page should not break because of it.
    ``overrides`` (tier → satang, set in the admin dashboard) replace mock
    amounts only; Stripe amounts are never overridden locally.
    """
    if client is None:
        return mock_plans(overrides)
    cached = _plans_cache.get(cache_key)
    if cached is not None and cached[0] > time.monotonic():
        return cached[1]
    async with _plans_lock:
        cached = _plans_cache.get(cache_key)
        if cached is not None and cached[0] > time.monotonic():
            return cached[1]
        try:
            fresh = await _fetch_plan_list(client)
        except stripe.StripeError as exc:
            log.error("billing_prices_unavailable", error_type=type(exc).__name__, error=str(exc))
            fresh = None
        if fresh is not None:
            _plans_cache[cache_key] = (time.monotonic() + _PLANS_TTL_SEC, fresh)
            return fresh
        fallback = cached[1] if cached is not None else MOCK_PLANS
        _plans_cache[cache_key] = (time.monotonic() + _PLANS_RETRY_SEC, fallback)
        return fallback
