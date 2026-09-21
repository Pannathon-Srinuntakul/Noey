"""The paid plans — the single source of tier ↔ lookup key ↔ mock amount.

Prices are NOT hardcoded anywhere else: the API reads live amounts from Stripe
by lookup key, and ``mock_unit_amount`` is only what GET /billing/plans shows
while Stripe is not configured (and what scripts/stripe_seed.py creates).

All amounts are MOCK figures from the owner's pricing design (2026-09-21) —
not yet costed. Change one here and re-run the seed: it creates a new Price
and moves the lookup key to it; existing subscribers keep their old price.
"""

from dataclasses import dataclass

CURRENCY = "thb"
INTERVAL = "month"
FREE_TIER = "free"

#: Subscription statuses that keep the paid tier (the owner's rule). Anything
#: else — incomplete, incomplete_expired, unpaid, paused, canceled — is free.
LIVE_STATUSES = frozenset({"active", "trialing", "past_due"})

#: Metadata key the seed script writes on every Product and Price it creates.
#: A price that lost its lookup key (a price change) still names its tier here,
#: so a grandfathered subscriber is never mistaken for a free user.
TIER_METADATA_KEY = "noey_tier"

#: Tags every Checkout Session so the Dashboard can compare checkout flows.
#: Fixed per flow on purpose (the random suffix makes it unique to this
#: integration; a per-session value could not be grouped).
INTEGRATION_IDENTIFIER = "noey-site-subscribe-vkzpofat"


@dataclass(frozen=True)
class PaidPlan:
    tier: str
    lookup_key: str
    #: MOCK amount in satang (THB x 100).
    mock_unit_amount: int
    #: Stripe Product id the seed creates — one Product per tier, so Checkout,
    #: invoices and the portal can tell the tiers apart.
    product_id: str
    product_name: str


#: Cheapest first — the order is the tier ranking (upgrade = later in the list).
PAID_PLANS: tuple[PaidPlan, ...] = (
    PaidPlan("lite", "noey_lite_monthly", 19_000, "noey_lite", "Noey Lite"),
    PaidPlan("starter", "noey_starter_monthly", 29_000, "noey_starter", "Noey Starter"),
    PaidPlan("pro", "noey_pro_monthly", 93_000, "noey_pro", "Noey Pro"),
    PaidPlan("studio", "noey_studio_monthly", 189_000, "noey_studio", "Noey Studio"),
)

_BY_KEY = {p.lookup_key: p for p in PAID_PLANS}
_BY_TIER = {p.tier: p for p in PAID_PLANS}


def plan_for_lookup_key(lookup_key: str | None) -> PaidPlan | None:
    return _BY_KEY.get(lookup_key or "")


def plan_for_tier(tier: str | None) -> PaidPlan | None:
    return _BY_TIER.get(tier or "")


def tier_rank(tier: str | None) -> int:
    """1..4 for the paid tiers in price order; 0 for free or anything unknown."""
    for rank, plan in enumerate(PAID_PLANS, start=1):
        if plan.tier == tier:
            return rank
    return 0


def is_live(status: str | None) -> bool:
    return status in LIVE_STATUSES
