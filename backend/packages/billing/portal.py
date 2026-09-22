"""The customer-portal configuration the seed script and admin price edits share.

A portal deep link (POST /billing/change-plan) may only target a price listed
in the configuration, so whenever a tier's price is replaced — by the seed
script's ``--reprice`` or by an admin price edit — the configuration has to be
updated with the new price ids.
"""

from stripe.params.billing_portal import ConfigurationCreateParamsFeatures

from packages.billing import catalog

#: Marks the portal configuration the seed script owns, so a re-run finds it.
PORTAL_MARKER = {"managed_by": "noey_stripe_seed"}


def portal_features(price_ids: dict[str, str]) -> ConfigurationCreateParamsFeatures:
    return {
        "invoice_history": {"enabled": True},
        "payment_method_update": {"enabled": True},
        "subscription_cancel": {
            "enabled": True,
            "mode": "at_period_end",
            # Required with at_period_end: nothing to prorate at a natural end.
            "proration_behavior": "none",
            "cancellation_reason": {
                "enabled": True,
                "options": ["too_expensive", "missing_features", "switched_service", "unused", "other"],
            },
        },
        "subscription_update": {
            "enabled": True,
            "default_allowed_updates": ["price"],
            # A deep link (POST /billing/change-plan) may only target a price
            # listed here — hence the re-run after every price change.
            "products": [
                {"product": plan.product_id, "prices": [price_ids[plan.tier]]}
                for plan in catalog.PAID_PLANS
            ],
            # Upgrades: take effect now, prorated, invoiced (charged) now.
            "proration_behavior": "always_invoice",
            # Downgrades (a cheaper item amount): scheduled for period end.
            "schedule_at_period_end": {"conditions": [{"type": "decreasing_item_amount"}]},
            "billing_cycle_anchor": "unchanged",
        },
    }
