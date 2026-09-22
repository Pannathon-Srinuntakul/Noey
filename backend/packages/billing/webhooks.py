"""Stripe webhook: verify, deduplicate, resolve the customer, re-sync.

A paid one-time TOP-UP Checkout Session (``mode=payment`` with ``noey_topup``
metadata) is the exception: it credits the wallet directly
(packages/billing/topup.py) instead of re-syncing a subscription. Its way
back — a refund (``charge.refunded``) or a chargeback
(``charge.dispute.created``) — takes the unspent balance back out of that
lot; a failed delayed payment (``checkout.session.async_payment_failed``)
credited nothing and is only acknowledged.

Every handled event funnels into the same sync (``service.sync_account``): the
event only says WHICH customer changed; what changed is re-read from Stripe.
That makes the handler immune to out-of-order and duplicated delivery, and
independent of the event payload's API version.
"""

from __future__ import annotations

from typing import Any

import stripe
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import topup
from packages.billing.objects import field, id_of, metadata_value
from packages.billing.service import lock_account, lock_account_by_customer, sync_account
from packages.core.logging import get_logger
from packages.db.models.billing import BillingAccount, StripeEvent
from packages.db.models.core_auth import User

log = get_logger(__name__)

#: The events to enable on the webhook endpoint (scripts/stripe_seed.py prints
#: this list). `customer.updated` is beyond the subscription lifecycle: it is
#: how a card changed in the portal reaches the stored brand/last4.
HANDLED_EVENTS: tuple[str, ...] = (
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    *topup.REVERSAL_EVENTS,
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "invoice.paid",
    "invoice.payment_failed",
    "customer.updated",
)
_HANDLED = frozenset(HANDLED_EVENTS)


def construct_event(payload: bytes, sig_header: str | None, secret: str) -> stripe.Event:
    """Verify ``Stripe-Signature`` over the RAW body (HMAC-SHA256, 5-minute
    tolerance) and parse the event.

    Raises ``stripe.SignatureVerificationError`` for a missing/bad/stale
    signature and ``ValueError`` for a body that is not JSON.
    """
    return stripe.Webhook.construct_event(payload, sig_header, secret)


async def _first_delivery(session: AsyncSession, event: stripe.Event) -> bool:
    """Record the event id; False when it was already processed.

    In the SAME transaction as the sync: a failure rolls the id back too, so
    Stripe's retry is processed again. A concurrent delivery of the same id
    blocks on the primary key until this transaction ends.
    """
    inserted = await session.execute(
        pg_insert(StripeEvent)
        .values(id=event.id, type=event.type)
        .on_conflict_do_nothing(index_elements=[StripeEvent.id])
        .returning(StripeEvent.id)
    )
    return inserted.scalar_one_or_none() is not None


def _customer_id(obj: Any) -> str | None:
    if field(obj, "object") == "customer":
        return id_of(obj)
    return id_of(field(obj, "customer"))


async def _claim_by_metadata(
    session: AsyncSession, obj: Any, customer_id: str
) -> BillingAccount | None:
    """FALLBACK only: an event for a customer id we never stored.

    Normally impossible — the id is stored before any Checkout Session is
    created. Uses the user id our own code wrote on the Checkout Session
    (client_reference_id / metadata) or the subscription (metadata), and only
    ever claims the customer for a user who has no billing row yet.
    """
    raw = field(obj, "client_reference_id") or metadata_value(obj, "user_id")
    if not raw or not str(raw).isdigit():
        return None
    user = await session.get(User, int(raw))
    if user is None:
        return None
    await session.execute(
        pg_insert(BillingAccount)
        .values(user_id=int(user.id), stripe_customer_id=customer_id)
        .on_conflict_do_nothing()
    )
    account = await lock_account(session, int(user.id))
    if account is None or account.stripe_customer_id != customer_id:
        log.error(
            "stripe_event_customer_mismatch",
            user_id=user.id,
            event_customer=customer_id,
            stored_customer=account.stripe_customer_id if account else None,
        )
        return None
    log.warning("stripe_event_claimed_by_metadata", user_id=user.id, customer=customer_id)
    return account


async def handle_event(session: AsyncSession, client: stripe.StripeClient, event: stripe.Event) -> str:
    """Apply one verified event and commit. Returns what happened (for the log).

    Raises on Stripe/database errors WITHOUT committing — the caller answers
    5xx and Stripe redelivers.
    """
    if not await _first_delivery(session, event):
        return "duplicate"
    if event.type not in _HANDLED:
        await session.commit()
        return "ignored"

    obj = event.data.object
    if event.type in topup.REVERSAL_EVENTS:
        # Only a top-up's money is ours to take back here; a subscription
        # charge is not in the wallet (reverse_from_event answers not_topup).
        outcome = await topup.reverse_from_event(session, event.type, event.id, obj, client=client)
        await session.commit()
        return f"topup_{outcome}"
    if event.type == "checkout.session.async_payment_failed":
        # A delayed method (PromptPay) never paid: nothing was credited, and
        # a subscription checkout that fails this way leaves no subscription.
        await session.commit()
        return "payment_failed"
    if event.type.startswith("checkout.session."):
        if topup.is_topup_session(obj):
            # A one-time top-up (packages/billing/topup.py): credit the wallet
            # once per session — completed (card) or async_payment_succeeded
            # (PromptPay) may both arrive; the unique session id dedupes.
            outcome = await topup.credit_from_session(session, obj)
            await session.commit()
            return f"topup_{outcome}"
        if field(obj, "mode") != "subscription":
            await session.commit()
            return "ignored"
        # Delayed payment methods complete the session before the money
        # arrives; async_payment_succeeded (or the subscription events) follow.
        if event.type == "checkout.session.completed" and field(obj, "payment_status") == "unpaid":
            await session.commit()
            return "awaiting_payment"

    customer_id = _customer_id(obj)
    if not customer_id:
        await session.commit()
        return "no_customer"

    account = await lock_account_by_customer(session, customer_id)
    if account is None:
        account = await _claim_by_metadata(session, obj, customer_id)
    if account is None:
        log.warning("stripe_event_unknown_customer", event_id=event.id, customer=customer_id)
        await session.commit()
        return "unknown_customer"

    user = (
        await session.execute(
            select(User).where(User.id == account.user_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    await sync_account(session, client, account, user)
    await session.commit()
    return "synced"
