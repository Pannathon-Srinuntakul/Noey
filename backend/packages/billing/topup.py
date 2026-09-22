"""Buying top-up balance: a Stripe one-time Checkout, or a mock on a dev box.

``create_checkout`` returns the URL the client opens. With Stripe configured
it is a hosted Checkout Session in ``mode=payment`` for one pack (THB, inline
``price_data`` — no Product/Price to seed), restricted to the method the
buyer picked (PromptPay is offered first by the client: 1.65% vs card 3.65%
+ ฿10). The balance is credited by the webhook
(``checkout.session.completed`` paid, or ``async_payment_succeeded`` for
PromptPay) through ``credit_from_session`` — idempotent per session id.

Without Stripe, and only when BOTH ``WALLET_MOCK_TOPUP=1`` is set and the
database is on loopback (``is_loopback_host``), the pack is credited at once
as a ``mock`` lot so the flow can be exercised end to end. Anything else
without Stripe is refused (503). The earlier rule — "the database host looks
like a developer's machine" — also matched docker-compose service names
(``postgres``/``db``), so a self-hosted compose deployment without Stripe keys
handed out free balance to anyone who asked; a mock must never mint money on a
real deployment, and startup refuses the flag there
(``assert_production_secrets``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import wallet
from packages.billing.objects import field, id_of, metadata_value
from packages.core.logging import get_logger
from packages.core.settings import get_settings, is_loopback_host

log = get_logger(__name__)

PRODUCT_NAME = "Noey extra usage"
METADATA_KEY = "noey_topup"


class TopupUnavailable(Exception):
    """No payment provider here, and this is not a local deployment."""


def mock_allowed() -> bool:
    """The no-payment mock: explicit opt-in AND the database on loopback."""
    s = get_settings()
    return bool(s.wallet_mock_topup) and is_loopback_host(s.postgres_host)


def return_url(status: str) -> str:
    base = get_settings().frontend_url.strip().rstrip("/")
    return f"{base}/settings?tab=usage&topup={status}"


def checkout_params(user_id: int, pack_satang: int, method: str, customer_id: str | None) -> dict[str, Any]:
    """The Checkout Session a top-up creates (pure — tested as data)."""
    params: dict[str, Any] = {
        "mode": "payment",
        "client_reference_id": str(user_id),
        "line_items": [
            {
                "price_data": {
                    "currency": "thb",
                    "unit_amount": int(pack_satang),
                    "product_data": {"name": PRODUCT_NAME},
                },
                "quantity": 1,
            }
        ],
        "payment_method_types": [method],
        "metadata": {METADATA_KEY: str(int(pack_satang)), "user_id": str(user_id), "method": method},
        "payment_intent_data": {"metadata": {METADATA_KEY: str(int(pack_satang)), "user_id": str(user_id)}},
        "success_url": return_url("success") + "&session_id={CHECKOUT_SESSION_ID}",
        "cancel_url": return_url("cancel"),
    }
    if customer_id:
        params["customer"] = customer_id
    return params


def validate(pack_satang: int, method: str) -> None:
    if pack_satang not in wallet.PACKS_SATANG:
        raise ValueError("unknown pack")
    if method not in wallet.METHODS:
        raise ValueError("unknown payment method")


async def create_checkout(
    session: AsyncSession, user: Any, pack_satang: int, method: str, *, client: Any = None
) -> str:
    """The URL to pay at (or, mocked, the success URL — already credited)."""
    validate(pack_satang, method)
    if client is not None:
        from packages.billing.service import get_account

        account = await get_account(session, int(user.id))
        params = checkout_params(
            int(user.id), pack_satang, method, account.stripe_customer_id if account else None
        )
        if not params.get("customer"):
            params["customer_email"] = str(user.email)
        checkout = await client.v1.checkout.sessions.create_async(params)
        log.info("topup_checkout_created", user_id=int(user.id), pack=pack_satang, method=method)
        return str(checkout.url)

    if not mock_allowed():
        raise TopupUnavailable()
    await wallet.credit(session, int(user.id), pack_satang, source="mock", payment_method=method,
                        note="mock top-up (no payment provider on this machine)")
    log.warning("topup_mock_credited", user_id=int(user.id), pack=pack_satang)
    return return_url("success")


def is_topup_session(obj: Any) -> bool:
    return field(obj, "mode") == "payment" and metadata_value(obj, METADATA_KEY) is not None


async def credit_from_session(session: AsyncSession, obj: Any, *, now: datetime | None = None) -> str:
    """Credit a paid top-up Checkout Session once. Returns what happened."""
    if field(obj, "payment_status") != "paid":
        return "awaiting_payment"
    raw_user = metadata_value(obj, "user_id") or field(obj, "client_reference_id")
    raw_pack = metadata_value(obj, METADATA_KEY)
    if not raw_user or not str(raw_user).isdigit():
        log.error("topup_session_without_user", session=field(obj, "id"))
        return "no_user"
    amount = field(obj, "amount_total")
    try:
        satang = int(amount) if isinstance(amount, int) else int(str(raw_pack))
    except (TypeError, ValueError):
        log.error("topup_session_without_amount", session=field(obj, "id"))
        return "no_amount"
    types = field(obj, "payment_method_types") or []
    method = metadata_value(obj, "method") or (types[0] if isinstance(types, list) and types else None)
    lot = await wallet.credit(
        session, int(raw_user), satang, source="stripe", now=now,
        stripe_session_id=str(field(obj, "id")), payment_method=str(method)[:16] if method else None,
        stripe_payment_intent=id_of(field(obj, "payment_intent")),
    )
    return "credited" if lot is not None else "duplicate"


# ── money coming back: refunds and disputes ─────────────────────────────────
#
# A top-up refunded in the Stripe dashboard (``charge.refunded``) or lost to a
# chargeback (``charge.dispute.created``) must not leave the balance spendable:
# that baht would become AI runs nobody paid for. Both events name the
# PaymentIntent, not the Checkout Session, so the lot stores it at credit time
# (lots credited before that are found through Stripe once and back-filled).
# What is still unspent in the lot is taken back with a ``reversal`` ledger
# row; what was already spent cannot be, and is flagged for the admin (an
# audit event + an error log). Event-level idempotency is the webhook's own
# ``stripe_events`` table; ``wallet.reverse_lot`` is cumulative on top of that.

REVERSAL_EVENTS: tuple[str, ...] = ("charge.refunded", "charge.dispute.created")


async def _lot_for_payment_intent(
    session: AsyncSession, payment_intent: str, client: Any
) -> Any:
    from packages.db.models.wallet import WalletLot

    lot = (
        await session.execute(select(WalletLot).where(WalletLot.stripe_payment_intent == payment_intent))
    ).scalar_one_or_none()
    if lot is not None or client is None:
        return lot
    # A lot credited before the PaymentIntent was stored: ask Stripe which
    # Checkout Session it paid, then remember the answer on the lot.
    found = await client.v1.checkout.sessions.list_async({"payment_intent": payment_intent, "limit": 1})
    sessions = list(field(found, "data") or [])
    if not sessions:
        return None
    lot = (
        await session.execute(select(WalletLot).where(WalletLot.stripe_session_id == id_of(sessions[0])))
    ).scalar_one_or_none()
    if lot is not None:
        lot.stripe_payment_intent = payment_intent
    return lot


async def reverse_from_event(
    session: AsyncSession, event_type: str, event_id: str, obj: Any, *, client: Any = None
) -> str:
    """Take a refunded / disputed top-up back from its lot. Returns what happened."""
    payment_intent = id_of(field(obj, "payment_intent"))
    if not payment_intent:
        return "no_payment_intent"
    lot = await _lot_for_payment_intent(session, payment_intent, client)
    if lot is None:
        return "not_topup"  # a subscription charge, or a payment we never credited
    if event_type == "charge.dispute.created":
        owed = int(field(obj, "amount") or 0) or int(lot.amount_satang)
    else:
        owed = int(field(obj, "amount_refunded") or 0)
    taken, shortfall = await wallet.reverse_lot(
        session, lot, owed, note=f"{event_type} {event_id}"[:200],
    )
    log.info(
        "topup_reversed", user_id=int(lot.user_id), lot_id=int(lot.id), event_type=event_type,
        taken_satang=taken, shortfall_satang=shortfall,
    )
    if shortfall > 0:
        from packages.admin import auth as admin_auth

        log.error(
            "topup_reversal_shortfall", user_id=int(lot.user_id), lot_id=int(lot.id),
            shortfall_satang=shortfall, event_type=event_type,
        )
        await admin_auth.audit(
            session, "topup_reversal_shortfall", target_user_id=int(lot.user_id),
            detail={"lot_id": int(lot.id), "event": event_type, "event_id": event_id,
                    "shortfall_satang": shortfall, "taken_satang": taken},
        )
    return "reversed" if shortfall == 0 else "reversed_short"
