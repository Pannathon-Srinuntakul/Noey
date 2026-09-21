"""Create or refresh the Stripe side of billing. Safe to run any number of times.

    cd backend && python scripts/stripe_seed.py            # test / sandbox key
    cd backend && python scripts/stripe_seed.py --live     # required for a live key
    cd backend && python scripts/stripe_seed.py --reprice  # apply changed catalog amounts

Reads STRIPE_SECRET_KEY, SITE_URL and STRIPE_PORTAL_CONFIGURATION_ID from the
environment / .env exactly like the API does, and:

1. One Product per paid tier (fixed ids: noey_lite, noey_starter, …).
2. One monthly THB Price per tier carrying the catalog lookup key. When the
   amount in packages/billing/catalog.py changed (and --reprice is given), a
   NEW price takes over the lookup key (`transfer_lookup_key`) and the old one
   is archived — existing subscribers keep paying the old price until they
   change plan. Without --reprice a differing price is reported and kept.
3. A customer-portal configuration: invoice history, payment-method update,
   cancel at period end, and switching between the four current prices —
   upgrades invoiced immediately with proration, downgrades scheduled for the
   end of the period.

Prints the portal configuration id (→ STRIPE_PORTAL_CONFIGURATION_ID) and the
webhook events to enable. See docs/billing-stripe.md.
"""

import argparse
import pathlib
import sys
from typing import Any, cast

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import stripe
from stripe.params.billing_portal import (
    ConfigurationCreateParamsFeatures,
)

from packages.billing import catalog
from packages.billing.catalog import PaidPlan
from packages.billing.client import (
    STRIPE_API_VERSION,
    build_stripe_client,
    is_live_mode_key,
)
from packages.billing.objects import field, id_of, metadata_value
from packages.billing.webhooks import HANDLED_EVENTS
from packages.core.settings import get_settings, is_localhost_url

#: Marks the portal configuration this script owns, so a re-run finds it.
PORTAL_MARKER = {"managed_by": "noey_stripe_seed"}


def _say(message: str) -> None:
    print(message, flush=True)


def ensure_product(client: stripe.StripeClient, plan: PaidPlan) -> None:
    try:
        product = client.v1.products.retrieve(plan.product_id)
    except stripe.InvalidRequestError as exc:
        if exc.code != "resource_missing":
            raise
        client.v1.products.create(
            {
                "id": plan.product_id,
                "name": plan.product_name,
                "metadata": {catalog.TIER_METADATA_KEY: plan.tier},
            }
        )
        _say(f"  product {plan.product_id}: created ({plan.product_name})")
        return
    if not product.active or metadata_value(product, catalog.TIER_METADATA_KEY) != plan.tier:
        client.v1.products.update(
            plan.product_id, {"active": True, "metadata": {catalog.TIER_METADATA_KEY: plan.tier}}
        )
        _say(f"  product {plan.product_id}: re-activated / metadata restored")
    else:
        _say(f"  product {plan.product_id}: ok")


def _price_matches(price: Any, plan: PaidPlan) -> bool:
    recurring = field(price, "recurring")
    return (
        id_of(field(price, "product")) == plan.product_id
        and field(price, "currency") == catalog.CURRENCY
        and field(price, "unit_amount") == plan.mock_unit_amount
        and field(recurring, "interval") == catalog.INTERVAL
        and field(recurring, "interval_count") == 1
    )


def ensure_price(client: stripe.StripeClient, plan: PaidPlan, *, reprice: bool) -> str:
    """The id of the price holding the plan's lookup key, creating/replacing it as needed.

    A price that differs from the catalog is only replaced with ``reprice``:
    someone may have set the real amount in the Dashboard, and a routine
    re-run must never quietly put the mock amount back on sale.
    """
    found = client.v1.prices.list({"lookup_keys": [plan.lookup_key], "limit": 1})
    current = found.data[0] if found.data else None
    if current is not None and _price_matches(current, plan):
        if not current.active or metadata_value(current, catalog.TIER_METADATA_KEY) != plan.tier:
            client.v1.prices.update(
                current.id, {"active": True, "metadata": {catalog.TIER_METADATA_KEY: plan.tier}}
            )
        _say(f"  price {plan.lookup_key}: ok ({current.id}, {plan.mock_unit_amount / 100:.2f} THB)")
        return current.id
    if current is not None and not reprice:
        live_amount = field(current, "unit_amount")
        shown = f"{live_amount / 100:.2f}" if isinstance(live_amount, int) else "?"
        _say(
            f"  price {plan.lookup_key}: KEPT {current.id} ({shown} {field(current, 'currency')}) — "
            f"the catalog says {plan.mock_unit_amount / 100:.2f} THB/month. "
            "Re-run with --reprice to move the lookup key to a new price."
        )
        return current.id

    created = client.v1.prices.create(
        {
            "product": plan.product_id,
            "currency": catalog.CURRENCY,
            "unit_amount": plan.mock_unit_amount,
            "recurring": {"interval": "month", "interval_count": 1},
            "lookup_key": plan.lookup_key,
            # Moves the key off `current` in the same call.
            "transfer_lookup_key": current is not None,
            "nickname": f"{plan.product_name} monthly",
            "metadata": {catalog.TIER_METADATA_KEY: plan.tier},
        }
    )
    if current is None:
        _say(f"  price {plan.lookup_key}: created ({created.id}, {plan.mock_unit_amount / 100:.2f} THB)")
    else:
        # Archived, not deleted: subscriptions on it keep renewing at the old
        # amount; it only stops being offered.
        client.v1.prices.update(current.id, {"active": False})
        _say(
            f"  price {plan.lookup_key}: amount changed — {created.id} "
            f"({plan.mock_unit_amount / 100:.2f} THB) now holds the key; "
            f"archived {current.id}"
        )
    return created.id


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


def ensure_portal_configuration(
    client: stripe.StripeClient, price_ids: dict[str, str], site_url: str, configured_id: str
) -> str:
    features = portal_features(price_ids)
    return_url = f"{site_url.rstrip('/')}/account/billing"

    existing_id = configured_id or None
    if existing_id is None:
        page = client.v1.billing_portal.configurations.list({"is_default": False, "limit": 100})
        for config in page.data:
            if metadata_value(config, "managed_by") == PORTAL_MARKER["managed_by"]:
                existing_id = config.id
                break

    if existing_id is None:
        created = client.v1.billing_portal.configurations.create(
            {
                "name": "Noey site",
                "features": features,
                "default_return_url": return_url,
                "metadata": PORTAL_MARKER,
            }
        )
        _say(f"  portal configuration: created {created.id}")
        return created.id

    # The update endpoint takes the same feature fields; the create-typed
    # dict above is what mypy checks the names against.
    client.v1.billing_portal.configurations.update(
        existing_id,
        {
            "active": True,
            "features": cast(Any, features),
            "default_return_url": return_url,
            "metadata": PORTAL_MARKER,
        },
    )
    _say(f"  portal configuration: updated {existing_id}")
    return existing_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--live",
        action="store_true",
        help="allow running with a LIVE key (sk_live_/rk_live_) — creates real catalog objects",
    )
    parser.add_argument(
        "--reprice",
        action="store_true",
        help="when a Stripe price differs from packages/billing/catalog.py, create a new "
        "price at the catalog amount and move the lookup key to it (old price archived)",
    )
    args = parser.parse_args()

    settings = get_settings()
    key = (settings.stripe_secret_key or "").strip()
    if not key:
        _say("Refusing to run: STRIPE_SECRET_KEY is not set (environment or .env).")
        return 2
    if not key.startswith(("sk_", "rk_")):
        _say("Refusing to run: STRIPE_SECRET_KEY must be a secret (sk_) or restricted (rk_) key.")
        return 2
    live = is_live_mode_key(key)
    if live and not args.live:
        _say("Refusing to run: this is a LIVE key. Re-run with --live when you mean it.")
        return 2
    if is_localhost_url(settings.site_url):
        _say(f"note: SITE_URL is {settings.site_url} — fine for a sandbox, wrong for live.")

    client = build_stripe_client(key, asynchronous=False)
    _say(f"Stripe {'LIVE' if live else 'test/sandbox'} mode · API {STRIPE_API_VERSION}")
    try:
        _say("Products and prices:")
        price_ids: dict[str, str] = {}
        for plan in catalog.PAID_PLANS:
            ensure_product(client, plan)
            price_ids[plan.tier] = ensure_price(client, plan, reprice=args.reprice)
        _say("Customer portal:")
        portal_id = ensure_portal_configuration(
            client,
            price_ids,
            settings.site_url,
            (settings.stripe_portal_configuration_id or "").strip(),
        )
    except stripe.StripeError as exc:
        _say(f"Stripe refused: {type(exc).__name__}: {exc}")
        _say("A restricted key needs Products/Prices/Customer portal WRITE to seed.")
        return 1

    _say("")
    _say(f"STRIPE_PORTAL_CONFIGURATION_ID={portal_id}")
    _say("")
    _say("Webhook endpoint → https://<your-api-host>/billing/webhook")
    _say(f"  API version to select: {STRIPE_API_VERSION}")
    _say("  Events to send:")
    for event_type in HANDLED_EVENTS:
        _say(f"    {event_type}")
    _say("Then set STRIPE_WEBHOOK_SECRET to the endpoint's signing secret (whsec_…).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
