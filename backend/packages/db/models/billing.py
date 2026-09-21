"""Core-schema billing models: one Stripe customer per user + webhook dedupe.

Stripe is the source of truth for subscriptions; these rows are the local
mirror the API reads (GET /billing/me) and the key the webhook resolves an
event's customer through. `users.plan` is what every limit reads — the webhook
keeps it in step (packages/billing/service.py). See docs/billing-stripe.md.
"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, false, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class BillingAccount(Base):
    """A user's Stripe customer and the subscription currently reflected in `users.plan`.

    The row exists from the moment a Stripe customer is created for the user
    (their first checkout), and is written BEFORE any Checkout Session is — so
    every webhook for that customer resolves to a user through
    `stripe_customer_id`, never through metadata.
    """

    __tablename__ = "billing_accounts"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Stripe object ids are opaque and may be up to 255 characters.
    stripe_customer_id: Mapped[str] = mapped_column(String(255), unique=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The catalog lookup key of the subscribed plan (packages/billing/catalog.py)
    # — also for a grandfathered price that no longer carries the key itself.
    price_lookup_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Stripe subscription status, verbatim (active, trialing, past_due, canceled, …).
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # True when the subscription is scheduled to end (`cancel_at_period_end`,
    # or `cancel_at` for flexible billing mode — the portal uses the latter).
    cancel_at_period_end: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    pm_brand: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pm_last4: Mapped[str | None] = mapped_column(String(4), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StripeEvent(Base):
    """Every webhook event id ever accepted — the idempotency ledger.

    Inserted in the SAME transaction that applies the event, so a failure rolls
    the id back with the change and Stripe's retry processes it again, while a
    duplicate delivery of a committed event is skipped.
    """

    __tablename__ = "stripe_events"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    type: Mapped[str] = mapped_column(String(128))
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
