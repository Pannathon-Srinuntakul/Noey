"""Plan change from inside the editor: preview, then apply
(docs/design/editor-limits.md §5–6; owner rules in packages/billing/plan_change.py).

``preview`` answers what the confirm dialog shows: which way the change goes,
what is charged NOW (prorated for the rest of the billing period) and what the
plan costs from the next period. ``apply`` does it:

- Stripe configured — no live subscription → a Checkout URL for the plan;
  a live subscription → the customer-portal confirm link (Stripe shows and
  takes the proration; upgrades immediately, downgrades at period end — the
  portal configuration's rule); to Free → cancel at period end.
- No Stripe, and only on a LOCAL deployment (``topup.mock_allowed``: the
  explicit ``WALLET_MOCK_TOPUP`` opt-in AND the database on loopback) —
  applied at once through ``plan_change`` (upgrade now, downgrade scheduled
  for the period end). Anywhere else without Stripe → 503.

Consent (the "ตัดบัตรทุกเดือน…" checkbox) is enforced by the route for every
change to a PAID plan — the client's disabled button is only the first check.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import stripe
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import catalog, plan_change, service, topup
from packages.billing.objects import field, items_of
from packages.core.logging import get_logger
from packages.core.settings import Settings
from packages.db.models.core_auth import User

log = get_logger(__name__)

Direction = Literal["upgrade", "downgrade", "same"]
Mode = Literal["checkout", "stripe_change", "stripe_cancel", "mock", "unavailable"]

#: The period assumed when there is no subscription to read one from (mock).
MOCK_PERIOD = timedelta(days=30)


class PlanSwitchError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ChangePreview:
    tier: str
    current: str
    direction: Direction
    #: What is charged now (satang). 0 for a downgrade.
    due_now_satang: int
    #: The plan's price from the next billing period (satang).
    next_price_satang: int
    #: When the new plan applies: now for an upgrade (after payment), the end
    #: of the paid period for a downgrade.
    effective_at: datetime | None
    mode: Mode
    #: True when ``due_now_satang`` came from the payment provider itself.
    exact: bool


@dataclass(frozen=True)
class ChangeResult:
    #: A page to send the user to (checkout / portal), else None.
    url: str | None
    #: True when the change is already done (or scheduled) server-side.
    applied: bool
    effective_at: datetime | None


def _now() -> datetime:
    return datetime.now(UTC)


def direction_of(current: str, target: str) -> Direction:
    a, b = catalog.tier_rank(current), catalog.tier_rank(target)
    return "same" if a == b else ("upgrade" if b > a else "downgrade")


def prorate_satang(
    old_satang: int, new_satang: int, period_end: datetime | None, now: datetime, *, paid: bool
) -> int:
    """What an upgrade costs now: the full price from Free, else the price
    difference for the part of the period that is left, rounded UP to the
    baht (a preview must never under-state the charge)."""
    if new_satang <= 0:
        return 0
    if not paid or period_end is None:
        return int(new_satang)
    remaining = max(0.0, min(1.0, (period_end - now).total_seconds() / MOCK_PERIOD.total_seconds()))
    diff = max(0, new_satang - old_satang) * remaining
    return int(math.ceil(diff / 100.0) * 100)


async def _stripe_preview_amount(
    client: stripe.StripeClient, sub: Any, price_id: str
) -> int | None:
    """Stripe's own number for switching ``sub`` to ``price_id`` now, or None."""
    items = items_of(sub)
    if len(items) != 1:
        return None
    try:
        invoice = await client.v1.invoices.create_preview_async({
            "customer": str(field(sub, "customer")),
            "subscription": str(field(sub, "id")),
            "subscription_details": {
                "items": [{"id": str(field(items[0], "id")), "price": price_id}],
                "proration_behavior": "always_invoice",
            },
        })
    except stripe.StripeError as exc:
        log.warning("plan_preview_stripe_failed", error=str(exc)[:200])
        return None
    amount = field(invoice, "amount_due")
    return int(amount) if isinstance(amount, int) else None


async def preview(
    session: AsyncSession,
    client: stripe.StripeClient | None,
    user: User,
    tier: str,
    prices: dict[str, int],
) -> ChangePreview:
    """``prices``: tier → monthly satang (from ``service.list_plans``)."""
    target = tier.lower().strip()
    if target != catalog.FREE_TIER and catalog.plan_for_tier(target) is None:
        raise PlanSwitchError(422, f"unknown plan: {tier!r}")
    current = str(user.plan or catalog.FREE_TIER)
    if current == plan_change.ENTERPRISE:
        raise PlanSwitchError(409, "แผนนี้ผู้ดูแลตั้งให้ เปลี่ยนเองไม่ได้")
    direction = direction_of(current, target)
    now = _now()
    state = await service.billing_state(session, user, enabled=client is not None)
    period_end = state.current_period_end
    paid = current != catalog.FREE_TIER
    new_price = int(prices.get(target, 0))
    old_price = int(prices.get(current, 0))

    if client is None:
        mode: Mode = "mock" if topup.mock_allowed() else "unavailable"
        if period_end is None and paid:
            period_end = now + MOCK_PERIOD
    elif target == catalog.FREE_TIER:
        mode = "stripe_cancel"
    elif state.status and catalog.is_live(state.status):
        mode = "stripe_change"
    else:
        mode = "checkout"

    due = 0
    exact = False
    if direction == "upgrade":
        due = prorate_satang(old_price, new_price, period_end, now, paid=paid and mode != "checkout")
        if mode == "stripe_change" and client is not None:
            try:
                _account, sub = await service._live_subscription(session, client, user)
                plan = catalog.plan_for_tier(target)
                if sub is not None and plan is not None:
                    price = await service._active_price(client, plan)
                    amount = await _stripe_preview_amount(client, sub, str(price.id))
                    if amount is not None:
                        due, exact = amount, True
            except (stripe.StripeError, service.BillingError) as exc:
                log.warning("plan_preview_fallback", error=str(exc)[:200])
    effective = now if direction == "upgrade" else (period_end or (now + MOCK_PERIOD))
    return ChangePreview(
        tier=target, current=current, direction=direction, due_now_satang=int(due),
        next_price_satang=new_price, effective_at=effective, mode=mode, exact=exact,
    )


async def apply(
    session: AsyncSession,
    client: stripe.StripeClient | None,
    settings: Settings,
    user: User,
    tier: str,
    prices: dict[str, int],
) -> ChangeResult:
    p = await preview(session, client, user, tier, prices)
    if p.direction == "same":
        raise PlanSwitchError(409, "ใช้แผนนี้อยู่แล้ว")

    if p.mode == "unavailable":
        raise PlanSwitchError(503, "ระบบชำระเงินยังไม่พร้อม ลองใหม่ภายหลัง")

    if p.mode == "mock":
        if p.direction == "upgrade":
            await plan_change.upgrade(session, user, p.tier)
            effective = _now()
        elif p.tier == catalog.FREE_TIER:
            await plan_change.schedule_cancel(session, user, p.effective_at or _now())
            effective = p.effective_at
        else:
            await plan_change.schedule_downgrade(session, user, p.tier, p.effective_at or _now())
            effective = p.effective_at
        await session.commit()
        log.info("plan_switch_mock", user_id=int(user.id), tier=p.tier, direction=p.direction)
        return ChangeResult(url=None, applied=True, effective_at=effective)

    assert client is not None
    try:
        if p.mode == "stripe_cancel":
            await service.cancel_subscription(session, client, user)
            return ChangeResult(url=None, applied=True, effective_at=p.effective_at)
        plan = catalog.plan_for_tier(p.tier)
        assert plan is not None
        if p.mode == "checkout":
            url = await service.create_checkout_session(session, client, settings, user, plan.lookup_key)
        else:
            url = await service.create_change_plan_session(session, client, settings, user, plan.lookup_key)
    except service.BillingError as exc:
        raise PlanSwitchError(exc.status_code, exc.detail) from None
    return ChangeResult(url=url, applied=False, effective_at=p.effective_at)
