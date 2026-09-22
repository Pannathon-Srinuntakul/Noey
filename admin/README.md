# Noey Studio — admin dashboard

Owner-only dashboard (Thai UI) built from the design `Admin Dashboard.dc.html`:
revenue, cost and profit from real usage logs, users and plans, editable cost
assumptions, plan prices, a forecast, and per-user actions (change plan, reset
today's AI quota, deactivate / reactivate). Next.js 16 App Router, created with
`create-next-app`; the same backend as the web editor and noey-frontend.

```bash
npm run dev          # http://localhost:3001 (API_URL defaults to http://localhost:8000)
npm run typecheck && npm run lint && npm test
npm run build        # standalone output; the Docker image runs .next/standalone/server.js
docker compose up -d admin   # from the repo root
```

Demo data for a LOCAL database: `cd backend && python scripts/seed_admin_demo.py`
(prints a one-time password for `owner@demo.noey.local`; `--remove` deletes it
all). Without SendGrid on a local database, the login code is printed on the
API's console.

## How it fits together

- **BFF only.** The browser talks to this app; this app talks to the backend's
  `/admin/*` routes (`backend/services/api/routers/admin.py`) with the admin's
  token from an HttpOnly cookie. `API_URL` is server-only.
- **Money lives in one place:** `src/lib/money.ts` (unit-tested in
  `money.test.ts`) turns the backend's usage FACTS — tokens per model and
  feature, speech-to-text seconds, finished/failed projects, subscription state
  — into every baht on screen, using the saved (or draft) cost config. The CSV
  export uses the same module.
- **What is real vs assumed.** Usage, users, plans, subscriptions, projects,
  quality tiers and quota are real. Prices of models, the STT package, fixed
  costs and per-user extras are the owner's editable assumptions (Costs tab).
  Revenue counts only active, non-admin accounts with a live Stripe
  subscription; past months' revenue in "month vs month" is an estimate from
  today's subscribers (no invoice history is stored). A plan with no users yet
  uses the design's per-user cost estimate, marked `*`.
- **Plan prices** (Pricing tab) → `PUT /admin/plan-prices`. With Stripe keys a
  new Stripe Price takes over the tier's lookup key (old one archived —
  existing subscribers keep their price) and the portal configuration is
  re-listed; without Stripe the amount is stored and `GET /billing/plans`
  serves it. Then noey-frontend's `POST /api/revalidate-prices` is called so
  the pricing pages update at once.
- **User actions** write the same columns the web editor reads: `users.plan`,
  `users.usage_reset_at` (today's quota window), `users.is_active` +
  `token_version` (deactivation signs the user out of the web app and desktop
  immediately).

## Security

- Login: password → 6-digit emailed code (10 min, single use, 5 tries) →
  server-side admin session (30-min access token + refresh, 30-min idle and
  12-h absolute limit). "Remember this device" (14 days) only skips the code.
- Cookies: HttpOnly, SameSite=Strict, and `__Host-` + Secure in production.
- Every Server Action and Route Handler checks Origin (plus Next.js's own
  check) and re-validates the session with the backend; `src/proxy.ts` only
  redirects and refreshes.
- Strict per-request nonce CSP (no third-party script), `frame-ancestors
  'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  HSTS in production, `noindex` everywhere (meta, header and robots.txt).
- CSV cells are escaped against spreadsheet formula injection.
