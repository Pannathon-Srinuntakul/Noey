"""Plan price edits from the admin dashboard.

Where the price lives decides what an edit does:

- **Stripe configured** — Stripe is the source of truth. Prices are immutable,
  so an edit creates a NEW monthly Price on the tier's Product that takes over
  the catalog lookup key (``transfer_lookup_key``), archives the old one and
  re-lists the new ids in the customer-portal configuration (a plan-change deep
  link may only target a listed price). Existing subscribers stay on their old
  price until they change plan — exactly what ``scripts/stripe_seed.py
  --reprice`` does. The amount is also recorded in ``plan_price_overrides``.
- **No Stripe** — ``plan_price_overrides`` IS the price: GET /billing/plans
  serves it in place of the catalog's mock amount.

Either way the plans cache is dropped so the next GET /billing/plans (and the
marketing site, once its ISR revalidates) shows the new amount.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

import stripe
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import catalog, service
from packages.billing.objects import field, metadata_value
from packages.billing.overrides import load_price_overrides
from packages.billing.portal import PORTAL_MARKER, portal_features
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.db.models.admin import PlanPriceOverride

log = get_logger(__name__)

#: Upper bound an admin may set, in THB per month.
MAX_PRICE_THB = 100_000


class PriceChangeError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class PriceChange:
    tier: str
    before: int  # satang
    after: int  # satang
    stripe_price_id: str | None = None


async def current_prices(session: AsyncSession, client: stripe.StripeClient | None) -> tuple[str, dict[str, int]]:
    """(source, tier → satang) exactly as GET /billing/plans reports them."""
    overrides = await load_price_overrides(session) if client is None else None
    plans = await service.list_plans(client, cache_key="admin", overrides=overrides)
    return plans.source, {p.tier: p.unit_amount for p in plans.plans}


async def _replace_stripe_price(client: stripe.StripeClient, plan: catalog.PaidPlan, amount: int) -> str:
    page = await client.v1.prices.list_async({"lookup_keys": [plan.lookup_key], "active": True, "limit": 1})
    current = page.data[0] if page.data else None
    created = await client.v1.prices.create_async(
        {
            "product": plan.product_id,
            "currency": catalog.CURRENCY,
            "unit_amount": amount,
            "recurring": {"interval": "month", "interval_count": 1},
            "lookup_key": plan.lookup_key,
            "transfer_lookup_key": current is not None,
            "nickname": f"{plan.product_name} monthly",
            "metadata": {catalog.TIER_METADATA_KEY: plan.tier, "set_by": "admin_dashboard"},
        }
    )
    if current is not None:
        # Archived, not deleted: subscriptions on it keep renewing unchanged.
        await client.v1.prices.update_async(str(field(current, "id")), {"active": False})
    return str(created.id)


async def _relist_portal_prices(client: stripe.StripeClient) -> None:
    """Point the portal configuration at the price each lookup key now holds."""
    page = await client.v1.prices.list_async(
        {"lookup_keys": [p.lookup_key for p in catalog.PAID_PLANS], "active": True, "limit": len(catalog.PAID_PLANS)}
    )
    ids = {str(field(p, "lookup_key")): str(field(p, "id")) for p in page.data}
    price_ids = {}
    for plan in catalog.PAID_PLANS:
        if plan.lookup_key not in ids:
            log.warning("admin_price_portal_skipped", missing=plan.lookup_key)
            return
        price_ids[plan.tier] = ids[plan.lookup_key]

    config_id = (get_settings().stripe_portal_configuration_id or "").strip() or None
    if config_id is None:
        configs = await client.v1.billing_portal.configurations.list_async({"is_default": False, "limit": 100})
        for config in configs.data:
            if metadata_value(config, "managed_by") == PORTAL_MARKER["managed_by"]:
                config_id = str(config.id)
                break
    if config_id is None:
        log.warning("admin_price_portal_missing", hint="run scripts/stripe_seed.py")
        return
    await client.v1.billing_portal.configurations.update_async(
        config_id, {"features": cast(Any, portal_features(price_ids))}
    )


async def change_prices(
    session: AsyncSession,
    client: stripe.StripeClient | None,
    new_prices_thb: dict[str, int],
    actor_id: int,
) -> list[PriceChange]:
    """Apply every changed tier; returns what changed (before/after in satang)."""
    _, before = await current_prices(session, client)
    changes: list[PriceChange] = []
    for tier, thb in new_prices_thb.items():
        plan = catalog.plan_for_tier(tier)
        if plan is None:
            raise PriceChangeError(422, f"'{tier}' is not a paid plan")
        if not 0 < thb <= MAX_PRICE_THB:
            raise PriceChangeError(422, f"price for {tier} must be 1–{MAX_PRICE_THB} THB")
        amount = int(thb) * 100
        if before.get(tier) == amount:
            continue
        stripe_id = None
        if client is not None:
            try:
                stripe_id = await _replace_stripe_price(client, plan, amount)
            except stripe.StripeError as exc:
                log.error("admin_price_stripe_failed", tier=tier, error_type=type(exc).__name__, error=str(exc))
                raise PriceChangeError(502, "the payment provider refused the new price") from exc
        await session.execute(
            pg_insert(PlanPriceOverride)
            .values(tier=tier, unit_amount=amount, updated_by=actor_id)
            .on_conflict_do_update(
                index_elements=[PlanPriceOverride.tier],
                set_={"unit_amount": amount, "updated_by": actor_id},
            )
        )
        changes.append(PriceChange(tier=tier, before=int(before.get(tier, 0)), after=amount, stripe_price_id=stripe_id))

    if changes and client is not None:
        try:
            await _relist_portal_prices(client)
        except stripe.StripeError as exc:
            # The prices changed; only plan switching via the portal lags until
            # the seed script re-runs. Say so rather than failing the edit.
            log.error("admin_price_portal_failed", error_type=type(exc).__name__, error=str(exc))
    service.reset_plans_cache()
    await session.flush()
    return changes


async def recorded_overrides(session: AsyncSession) -> dict[str, int]:
    rows = (await session.execute(select(PlanPriceOverride.tier, PlanPriceOverride.unit_amount))).all()
    return {t: int(a) for t, a in rows}
