"""Top-up wallet ("extra usage") — core schema.

A user sees a baht balance, never tokens (docs/token-billing-plan.md §6).
Money arrives as LOTS — one per purchase (or admin credit), each valid 12
months — and leaves FIFO by expiry. Every movement is one signed LEDGER row,
so the balance history is explainable line by line.

``wallet_lots.stripe_session_id`` is UNIQUE: the Stripe webhook may deliver
the same paid Checkout Session twice (``completed`` + ``async_payment_
succeeded``, or a retry) and it must credit exactly once.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA


class WalletLot(Base):
    __tablename__ = "wallet_lots"
    __table_args__ = (
        Index("ix_wallet_lots_user_id_expires_at", "user_id", "expires_at"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    #: stripe | mock | admin | refund
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    amount_satang: Mapped[int] = mapped_column(BigInteger, nullable=False)
    remaining_satang: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    stripe_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    #: The Checkout's PaymentIntent — how a later refund / dispute (which name
    #: the payment, not the session) finds the lot to take back.
    stripe_payment_intent: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    #: promptpay | card (what the buyer chose)
    payment_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class WalletLedger(Base):
    __tablename__ = "wallet_ledger"
    __table_args__ = (
        Index("ix_wallet_ledger_user_id_created_at", "user_id", "created_at"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    lot_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.wallet_lots.id", ondelete="SET NULL"), nullable=True
    )
    run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey(f"{CORE_SCHEMA}.ai_runs.id", ondelete="SET NULL"), nullable=True
    )
    #: purchase | debit | refund | expire | adjust | reversal (a top-up the
    #: payer refunded or disputed at Stripe, taken back from its lot)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Signed: credits positive, debits/expiry negative.
    amount_satang: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after_satang: Mapped[int] = mapped_column(BigInteger, nullable=False)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    #: The admin behind an ``adjust``.
    actor_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
