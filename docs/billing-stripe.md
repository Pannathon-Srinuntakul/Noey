# Billing with Stripe — self-service accounts and subscriptions

Written 2026-09-21. Backend only: `backend/packages/billing/`,
`backend/services/api/routers/billing.py`, `backend/services/api/routers/auth.py`.
The public marketing site (`noey-frontend/`) is the client; the existing web
app keeps working with the same accounts.

Everything is **off by default** and costs nothing to leave in place:

- `ALLOW_REGISTRATION=false` → `POST /auth/register` answers 403.
- No `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` → every `/billing` action
  answers 503 with the missing variable named, `GET /billing/plans` serves the
  mock prices and `GET /billing/me` reports `billing_enabled: false`. Login,
  refresh and every other route are unaffected.

---

## 1. Architecture

```
marketing site ──POST /auth/register──────────────► users + own tenant (free plan)
      │
      ├─POST /billing/checkout ──► Stripe customer (stored FIRST) ──► Checkout Session URL
      │                                                                   │ pays
      ├─POST /billing/change-plan ─► portal deep link (subscription_update_confirm)
      ├─POST /billing/cancel|resume ─► Subscriptions API (cancel at period end)
      └─POST /billing/portal ────► Stripe customer portal (card, invoices, plan)

Stripe ──POST /billing/webhook──► verify signature ─► record event id ─► resolve user by
                                   (raw body)          (idempotency)      stored customer id
                                                                              │
                         re-read ALL the customer's subscriptions from Stripe ◄┘
                         → core.billing_accounts (mirror) + users.plan (limits)
```

Principles:

- **Stripe is the source of truth; webhooks drive state.** The success page and
  every redirect are cosmetic. The handler never trusts the event payload: an
  event only says *which customer* changed, and the sync re-reads that
  customer's subscriptions (default payment method expanded). Out-of-order and
  duplicate deliveries are therefore harmless, and the payload's API version
  does not matter.
- **Customer id first.** `POST /billing/checkout` creates (or reuses) the Stripe
  customer and **commits** `billing_accounts.stripe_customer_id` before the
  Checkout Session exists, so every event resolves through our database.
  Metadata (`client_reference_id`, `metadata.user_id`) is only a fallback for a
  customer id that was never stored, and never re-binds a user who already has
  one.
- **Row lock before read.** Every sync locks the `billing_accounts` row and only
  then reads Stripe, so of two concurrent syncs the later one also read later —
  an older snapshot cannot overwrite a newer one.
- **Idempotency.** `core.stripe_events` stores every accepted event id, inserted
  in the same transaction as the sync. Failure → rollback → 5xx → Stripe
  redelivers and it is processed again; a duplicate of a committed event is
  answered `200 {"status":"duplicate"}`.
- **One `StripeClient`** per process, API version pinned to
  `2026-08-26.dahlia` (`packages/billing/client.py`), stripe-python 15.6.x. The
  module-level `stripe.api_key` is never set. Only `packages/billing` imports
  `stripe`.
- **One Product per tier** (fixed ids `noey_lite`, `noey_starter`, `noey_pro`,
  `noey_studio`, `noey_agency`, `noey_max`), one monthly THB Price each,
  addressed by lookup key.

### Plan rules (the owner's design)

| Rule | Where it is enforced |
|---|---|
| Live = `active`, `trialing`, `past_due` → `users.plan` = the price's tier; anything else → `free` | `catalog.LIVE_STATUSES`, `service.plan_for_subscription` |
| Upgrade: immediate, prorated, invoiced (charged) now | portal configuration `proration_behavior=always_invoice` (seed) |
| Downgrade: at the next billing cycle | portal configuration `schedule_at_period_end.conditions=[decreasing_item_amount]` (seed) — **verify, see §9** |
| Cancel: access until the period ends, then free | `POST /billing/cancel`, portal `subscription_cancel.mode=at_period_end`; `customer.subscription.deleted` → free |
| `enterprise` is admin-only | the sync never changes an `enterprise` user; checkout answers 409 for one |

More sync details:

- A price whose lookup key moved to a newer price (a price change) still maps
  to its tier through its `noey_tier` metadata — grandfathered subscribers are
  never demoted. A live subscription on a price that maps to **no** tier logs
  `billing_unknown_price` and leaves `users.plan` unchanged rather than guess.
- Several live subscriptions for one customer (should not happen: checkout
  refuses when one is live and expires the customer's other open Checkout
  Sessions) → the highest tier wins and `billing_multiple_live_subscriptions`
  is logged. Refund the duplicate in the Dashboard.
- The card shown is the subscription's default payment method, else the
  customer's `invoice_settings.default_payment_method` — the portal's card
  update sets the latter, which is why `customer.updated` is subscribed.
- Flexible billing mode (the default for new subscriptions since API
  `2025-09-30.clover`) schedules a cancellation with `cancel_at`, classic with
  `cancel_at_period_end`; both count as "scheduled to end". Our cancel uses
  `cancel_at=max_period_end` (flexible) / `cancel_at_period_end=true` (classic);
  resume clears whichever is set.

### New accounts and tenancy

`POST /auth/register` creates, in one transaction: the user (email trimmed +
lowercased, bcrypt hash, plan `free`), **its own tenant** with slug
`u<user id>` and schema `tenant_u<id>` (via `packages/db/tenancy.create_tenant_schema`),
and an `owner` membership.

The tenant business tables (`video_projects`, `effect_styles`) exist only in
`tenant_default` — every migration names that schema, and the API's
`db_session` binds `default` for every caller, isolating rows by `user_id`. So
`set_search_path_sql()` puts `tenant_default` after the tenant's own schema:
`SET search_path TO "tenant_u42", "tenant_default", core`. Without that, the
routers that re-bind the caller's tenant and every worker task (which binds
the job's tenant) would fail on a new account's first AI job. For `default`
the statement is byte-identical to before. Giving each tenant real tables is
a separate project (migrations would have to fan out over all tenant schemas).

Login matches the exact stored email first (unchanged for every existing
account) and only then case-insensitively, because registered addresses are
stored lowercased.

---

## 2. What is mock

| Item | Where | Status |
|---|---|---|
| Prices 199 / 399 / 990 / 1,990 / 3,990 / 6,990 THB per month (lite → max) | `packages/billing/catalog.py` (`mock_unit_amount`, satang) | **Owner-approved** 2026-09-22 (flat ฿250 per 1M usage tokens; sold as 1x/2x/5x/10x/20x/35x of Lite) |
| lite / studio / agency / max daily token limits | `packages/core/settings.py`, env `PLAN_<TIER>_MONTHLY_TOKENS` | **Placeholder** — the weekly / 5-hour windows in the owner's token unit replace them |
| lite / studio storage (3 GB / 30 GB) | settings, env `PLAN_LITE_STORAGE_BYTES`, `PLAN_STUDIO_STORAGE_BYTES` | Design figures |
| free / starter / pro storage | settings | **Still 10 GB each** — the design says 1 / 5 / 10 GB; aligning is the owner's call |
| free / starter / pro / enterprise token limits | settings | Unchanged (note free 10M > starter 2M today) |
| Product names "Noey Lite" … "Noey Studio" | catalog | Placeholder copy (set only when the product is created) |

`GET /billing/plans` shows Stripe's live amounts once the seed has run; the
catalog amounts only appear while Stripe is not configured (`source: "mock"`).

### Changing a price from the admin dashboard

The admin app's Pricing tab (`PUT /admin/plan-prices`,
`packages/admin/pricing.py`) is the owner's way to change a paid tier's price
without editing `catalog.py`:

- **Stripe configured:** Stripe stays the source of truth. The edit creates a
  NEW monthly THB Price on the tier's Product carrying the catalog lookup key
  (`transfer_lookup_key`), archives the old Price (never deletes it — existing
  subscribers keep renewing at their old amount until they change plan) and
  re-lists the current price ids in the customer-portal configuration, exactly
  like `scripts/stripe_seed.py --reprice`. The amount is also recorded in
  `core.plan_price_overrides` for the audit trail.
- **No Stripe:** `core.plan_price_overrides` IS the price — `GET /billing/plans`
  serves it in place of the mock amount (`source` stays `"mock"`).

Either way the plans cache is dropped and the admin app calls noey-frontend's
`POST /api/revalidate-prices` (shared `PRICES_REVALIDATE_SECRET`), so the
pricing pages, JSON-LD offers, `/pricing.md` and `/llms.txt` update at once.
Every change is written to `core.admin_audit_events` with before/after.
Note: re-running the seed with `--reprice` later resets Stripe to the amounts
in `catalog.py` — update the catalog if an admin-set price should stick.

---

## 3. Environment variables

Set on the **API service only** — the worker never talks to Stripe.

| Variable | Required | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | for billing | Restricted `rk_…` (recommended) or secret `sk_…` key. Publishable keys are refused. |
| `STRIPE_WEBHOOK_SECRET` | for billing | Signing secret `whsec_…` of the endpoint pointing at `/billing/webhook`. Billing stays off without it — money must never be taken without a way to hear about it. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | recommended | `bpc_…` printed by the seed. Unset → the account's default portal configuration, which must then allow switching between the four prices. |
| `SITE_URL` | for billing in production | Marketing site origin (default `http://localhost:3000`). Checkout/portal return URLs are built from it; it is added to CORS. On a non-local deployment a localhost value keeps billing off (503). |
| `BILLING_AUTOMATIC_TAX` | no (default `false`) | Stripe Tax on Checkout. See §8 before turning it on. |
| `ALLOW_REGISTRATION` | no (default `false`) | Opens `POST /auth/register`. |
| `TURNSTILE_SECRET_KEY` | no | Cloudflare Turnstile secret; when set, registration requires a valid `turnstile_token` (verified server-side, fails closed). |
| `PLAN_LITE_MONTHLY_TOKENS`, `PLAN_STUDIO_MONTHLY_TOKENS`, `PLAN_LITE_STORAGE_BYTES`, `PLAN_STUDIO_STORAGE_BYTES` | no | New plan limits, same shape as the existing ones. |

Keep keys in the platform's secret store (Railway variables), never in a file
that is shared. Use separate keys per environment.

---

## 4. Restricted API key permissions

Stripe's restricted-key editor lists resources with **None / Read / Write**
(write implies read). If a call is missing a permission, Stripe's 403 names
it and the API logs `stripe_access_denied` with that message.

**Runtime key (the API):**

| Resource | Permission | Used by |
|---|---|---|
| Customers | Write | create the customer at first checkout; read its default card |
| Checkout Sessions | Write | create; list + expire the customer's stale open sessions |
| Customer portal | Write | create portal sessions (portal + change-plan deep link) |
| Subscriptions | Write | list for sync; update for cancel/resume |
| Subscription schedules | Write | release a scheduled downgrade when the customer cancels |
| Prices | Read | resolve lookup keys; `/billing/plans` |
| PaymentMethods | Read | the expanded default payment method (brand/last4) |

**Seed key (one-off, can be a separate key or a secret key you then delete):**
Products **Write**, Prices **Write**, Customer portal **Write**.

---

## 5. Seed the Stripe account

```bash
cd backend
# in .env (or the environment): STRIPE_SECRET_KEY=sk_test_…/rk_test_…  SITE_URL=…
python scripts/stripe_seed.py            # sandbox / test mode
python scripts/stripe_seed.py --live     # refuses a live key without this flag
python scripts/stripe_seed.py --reprice  # after changing an amount in catalog.py
```

Idempotent. It creates/refreshes:

1. Products `noey_lite`, `noey_starter`, `noey_pro`, `noey_studio`, `noey_agency`, `noey_max` (metadata `noey_tier`).
2. Monthly THB prices with lookup keys `noey_lite_monthly`, `noey_starter_monthly`,
   `noey_pro_monthly`, `noey_studio_monthly`, `noey_agency_monthly`, `noey_max_monthly` (metadata `noey_tier`).
   A price that differs from the catalog is **kept and reported** unless
   `--reprice` is given; then a new price takes the lookup key
   (`transfer_lookup_key=true`) and the old one is archived — existing
   subscribers keep renewing at the old amount. (This way a routine re-run can
   never put the mock amount back on sale after real prices were set.)
3. A customer-portal configuration (metadata `managed_by=noey_stripe_seed`, or
   the one named by `STRIPE_PORTAL_CONFIGURATION_ID`): invoice history,
   payment-method update, cancel at period end (with reasons), and plan
   switching between the four **current** prices — upgrades
   `proration_behavior=always_invoice`, downgrades
   `schedule_at_period_end: decreasing_item_amount`. Re-run after every price
   change: a portal deep link can only target a price listed in the
   configuration, and the portal allows only one price per product+interval.

It prints `STRIPE_PORTAL_CONFIGURATION_ID=bpc_…` and the webhook events.

---

## 6. Webhook endpoint

URL: `https://<api-host>/billing/webhook` — create it in Workbench → Webhooks,
**API version `2026-08-26.dahlia`**, events:

```
checkout.session.completed
checkout.session.async_payment_succeeded
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
invoice.paid
invoice.payment_failed
customer.updated
```

(`customer.updated` carries portal card changes to the stored brand/last4.)
Then set `STRIPE_WEBHOOK_SECRET` to the endpoint's signing secret.

Responses: `400` bad/missing/stale signature (5-minute tolerance) or non-JSON;
`503` billing not configured; `500` when Stripe or the database failed (the
event is NOT recorded, Stripe retries for up to 3 days); `200` with
`{"status": "synced" | "duplicate" | "ignored" | "awaiting_payment" |
"unknown_customer" | "no_customer"}` otherwise. Processing is inline (one or
two Stripe reads, well under a second); `checkout.session.completed` with
`payment_status=unpaid` waits for `…async_payment_succeeded`.

Do not subscribe the endpoint to `invoice.created` unless it is needed: Stripe
delays invoice finalization up to 72 h when that event fails. (Our handler
would answer 200 `ignored`, so it is safe, just pointless.)

---

## 7. Local testing with the Stripe CLI

Use a **sandbox** (separate from live and from other developers), not live mode.

```bash
docker compose up -d postgres redis
cd backend && alembic upgrade head && uvicorn services.api.main:app --reload --port 8000

# another terminal
stripe login
stripe listen --forward-to localhost:8000/billing/webhook
# → "Your webhook signing secret is whsec_…" → STRIPE_WEBHOOK_SECRET in backend/.env, restart the API

python scripts/stripe_seed.py   # once per sandbox; put the printed bpc_… in .env
```

Then, with `ALLOW_REGISTRATION=true`:

1. `POST /auth/register` → token; `POST /billing/checkout {"lookup_key":"noey_lite_monthly"}`
   → open the URL, pay with `4242 4242 4242 4242` (any future date / CVC).
2. The `stripe listen` terminal shows the events; `GET /billing/me` → `plan: "lite"`.
3. `POST /billing/change-plan {"lookup_key":"noey_pro_monthly"}` → confirm in
   the portal → `plan: "pro"`; then back to lite → it should be **scheduled**
   (plan stays `pro` until the period ends — see §9).
4. `POST /billing/cancel` → `cancel_at_period_end: true`; `POST /billing/resume` → false.
5. Renewals / failures without waiting a month: Stripe test clocks, or
   `stripe trigger invoice.payment_failed`. Test card `4000 0000 0000 0341`
   attaches but fails charges (past_due path).

Unit tests (no network, fake Stripe client, real HMAC signatures):
`cd backend && pytest tests/test_billing.py tests/test_registration.py`.

---

## 8. Tax — Thailand VAT and Stripe Tax

`BILLING_AUTOMATIC_TAX` is off, and for this business it should probably stay
off: Stripe's supported-countries table (checked 2026-09-21) lists Thailand as
supported only as a **customer** location for digital products — a business
**located** in Thailand cannot use Stripe Tax at all. Turning the flag on would
not make Stripe collect Thai VAT.

What that leaves, to decide with an accountant:

- Below the VAT threshold (annual revenue 1.8M THB) there is no VAT to charge.
- Once VAT-registered, prices are normally shown VAT-inclusive to consumers;
  the prices were created with `tax_behavior` *unspecified*, which Stripe lets
  you set once, later, to `inclusive`/`exclusive`. Thai full tax invoices
  have format requirements Stripe's receipts may not meet — that is an
  accounting question, not a code one.
- If the owner ever sells from a Stripe-Tax-supported location, the switch is:
  head-office address + an active registration, product tax codes, then
  `BILLING_AUTOMATIC_TAX=true` (Checkout then also saves the collected address
  to the customer). With no active registration Stripe silently collects 0 tax.

Email receipts and invoices come from Stripe (see the checklist).

---

## 9. Go-live checklist

1. **Verify downgrades in a sandbox first.** The portal configuration asks for
   downgrades at period end via `schedule_at_period_end`, and the API
   reference documents it without restriction, but Stripe's Dashboard guide
   says scheduled downgrades work "between prices that have the same
   product" — and each tier is its own product. Run step 3 of §7: if a
   downgrade applies immediately (with a proration credit) instead of being
   scheduled, the portal cannot do it across products and downgrades need a
   server-side subscription schedule instead. Upgrades are unaffected.
2. Activate the Stripe account (business details, bank account, THB).
3. Settings → Payment methods: leave only **Cards** (+ wallets) for
   subscriptions — the code never passes `payment_method_types`, so this is a
   Dashboard choice.
4. Settings → Customer emails: enable **successful payment receipts** (and
   refunds); Settings → Billing → Subscriptions and emails: send finalized
   invoices, and configure failed-payment retries (Smart Retries) and what
   happens after the last retry (cancel → the account returns to free).
5. Branding and public business details (Checkout and the portal show them).
6. Create a **live restricted key** with the §4 permissions →
   `STRIPE_SECRET_KEY` on the Railway API service.
7. `python scripts/stripe_seed.py --live` → `STRIPE_PORTAL_CONFIGURATION_ID`.
8. Live webhook endpoint (§6) → `STRIPE_WEBHOOK_SECRET`.
9. `SITE_URL=https://<marketing origin>` on the API service.
10. Deploy; the migration `a4d977e35603` runs at API startup.
11. Smoke test with a real card and a real refund; confirm `GET /billing/me`
    follows each step.
12. `ALLOW_REGISTRATION=true` (and `TURNSTILE_SECRET_KEY`) when ready to open sign-up.
13. Review Stripe's go-live checklist: https://docs.stripe.com/get-started/checklist/go-live

---

## 10. API reference (for the marketing site)

All JSON; errors are FastAPI's `{"detail": …}`; auth is `Authorization: Bearer <access_token>`.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /auth/register` | `{email, password (8+ chars, ≤72 UTF-8 bytes), display_name?, turnstile_token?}` | 201 `{access_token, refresh_token, token_type}` (+ verification mail) | 403 closed · 409 email exists (any case) · 422 validation · 400 captcha failed · 429 |
| `GET /auth/me` | — | 200 `{user_id, email, tenant_id, tenant_slug, role, is_admin, display_name, email_verified}` | 401 |
| `PATCH /auth/me` | `{display_name}` (null/blank clears; ≤80 chars) | 200 MeOut | 401 · 422 |
| `POST /auth/change-password` | `{current_password, new_password}` | 200 TokenOut (revokes other sessions) | 400 wrong current · 401 · 422 · 429 |

Email verification, password reset, email change and the contact form:
`docs/email-sendgrid.md`.
| `GET /billing/plans` | — (public) | 200 `{source: "stripe"\|"mock", currency: "thb", plans: [{tier, lookup_key, interval: "month", unit_amount}]}` (satang; lite, starter, pro, studio, agency, max) | — |
| `GET /billing/me` | — | 200 `{plan, status, lookup_key, current_period_end (ISO), cancel_at_period_end, payment_method: {brand, last4}\|null, billing_enabled}` | 401 |
| `POST /billing/checkout` | `{lookup_key}` | 200 `{url}` | 409 live subscription exists / enterprise account · 422 unknown key · 502 Stripe failure · 503 not configured or price not seeded |
| `POST /billing/change-plan` | `{lookup_key}` | 200 `{url}` (portal confirm page) | 409 no live subscription / same plan / change already scheduled · 422 · 502 · 503 |
| `POST /billing/cancel` | — | 200 `/billing/me` shape (idempotent) | 409 no live subscription · 502 · 503 |
| `POST /billing/resume` | — | 200 `/billing/me` shape | 409 no live subscription / not scheduled to cancel · 502 · 503 |
| `POST /billing/portal` | — | 200 `{url}` | 409 no customer yet · 502 · 503 |
| `POST /billing/webhook` | Stripe only | 200 | 400 · 500 · 503 |

Redirects: Checkout success `{SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
cancel `{SITE_URL}/pricing?checkout=canceled`; portal return
`{SITE_URL}/account/billing`; after confirming a plan change
`{SITE_URL}/account/billing?plan_change=done`. None of these pages should
assume the new plan is already active — poll `GET /billing/me` (the webhook
usually lands within seconds).

---

## 11. Not built / known limits

- Email verification, password reset, email change, session revocation and
  rate limits now exist — see `docs/email-sendgrid.md`. Checkout does not
  require a verified email.
- 409 on register still reveals whether an address exists (rate-limited).
- **Account deletion** — none. Deleting a user row does NOT cancel a Stripe
  subscription; cancel it in Stripe first.
- **Refunds / disputes** — handled in the Dashboard; they do not change the
  plan by themselves (a canceled subscription does, via its webhook).
- A **scheduled downgrade** cannot be changed or undone by the customer until it
  takes effect (Stripe's portal refuses updates while a schedule is attached;
  `change-plan` answers 409). Cancelling does release it. The owner can
  release it in the Dashboard.
- **Per-tenant data schemas** — new tenants share `tenant_default` (§1).
- **Live Stripe calls were not exercised** during development — every test uses a
  fake client. Run §7 against a sandbox before launch.
