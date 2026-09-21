"""Stripe subscription billing for self-service accounts.

- ``catalog``  — the paid tiers: tier ↔ Stripe lookup key ↔ mock price. The one
  place a plan is defined.
- ``client``   — whether billing is configured, and the single StripeClient.
- ``service``  — checkout, plan change (portal deep link), cancel/resume,
  portal, the price list, and syncing Stripe's subscription state into
  ``core.billing_accounts`` + ``users.plan``.
- ``webhooks`` — signature verification and event dispatch.

Only this package imports ``stripe``. See docs/billing-stripe.md.
"""
