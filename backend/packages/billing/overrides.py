"""Admin-set plan prices, as GET /billing/plans reads them without Stripe.

Kept apart from packages/admin so the public billing router does not import
the admin package.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import catalog
from packages.db.models.admin import PlanPriceOverride


async def load_price_overrides(session: AsyncSession) -> dict[str, int]:
    """tier → satang for every paid tier an admin has priced."""
    rows = (await session.execute(select(PlanPriceOverride.tier, PlanPriceOverride.unit_amount))).all()
    return {tier: int(amount) for tier, amount in rows if catalog.plan_for_tier(tier) is not None}
