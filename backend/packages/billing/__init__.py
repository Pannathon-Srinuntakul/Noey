"""Stripe subscription billing for self-service accounts.

- ``catalog``  — the paid tiers: tier ↔ Stripe lookup key ↔ mock price. The one
  place a plan is defined.
- ``client``   — whether billing is configured, and the single StripeClient.
- ``service``  — checkout, plan change (portal deep link), cancel/resume,
  portal, the price list, and syncing Stripe's subscription state into
  ``core.billing_accounts`` + ``users.plan``.
- ``webhooks`` — signature verification and event dispatch.

Token billing (docs/token-billing-design.md):

- ``rate_card``   — vendor usage → our tokens (fixed, versioned forward-only).
- ``limits``      — plan limits in rate-card tokens (one table).
- ``estimate``    — server-side pre-flight estimate of one AI run.
- ``metering``    — durable usage rows (awaited, retried, Redis outbox).
- ``vendor_cost`` — real vendor cost (THB) of one request.
- ``fx``          — the USD→THB rate: daily fetch + admin override.

Only this package imports ``stripe``. See docs/billing-stripe.md.
"""
