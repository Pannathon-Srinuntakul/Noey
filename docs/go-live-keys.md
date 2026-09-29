# Go-live keys — the owner's checklist

Every key or secret the product needs before it takes real customers, in the
order to set them. Each integration is **off and harmless while its key is
unset** (verified 2026-09-30 against a keyless local API — see "What unset
looks like" at the end), so they can be turned on one at a time.

Railway services:

| Service | What it is |
|---|---|
| **Noey Api** | FastAPI backend (`backend/`) |
| **Noey Worker** | arq worker (`backend/services/worker`) |
| **Noey Frontend** | the **web editor** (`web/`) — Vite, `VITE_*` are BUILD args (change → redeploy rebuilds) |
| **Noey Studio** | the **marketing site** (`noey-frontend/`) — Next.js, `NEXT_PUBLIC_*` are baked at build |
| **Noey Dashboard** | the admin dashboard (`admin/`) |

Hosts used below: `<api-host>` = the Noey Api domain
(`noey-api-production.up.railway.app` today), `<site-host>` = the marketing
site's public domain (what `SITE_URL` / `NEXT_PUBLIC_SITE_URL` hold, e.g.
`noeystudio.com`), `<editor-host>` = the web editor's domain
(`noey-frontend-production.up.railway.app` today).

Rules for every row: paste secrets only into Railway variables
(https://docs.railway.com/guides/variables), never into a committed file; use
separate test and live keys; after changing a variable let Railway redeploy
the service and read its deploy log before testing.

---

## 0. Base secrets (the API refuses to boot on a real host without these)

- [ ] **`JWT_SECRET`** — a long random value (`python -c "import secrets;print(secrets.token_urlsafe(48))"`).
  - Services: **Noey Api** and **Noey Worker** — the SAME value on both.
  - Test: deploy; the log must NOT contain `Refusing to start: ... JWT_SECRET is the development placeholder`.
- [ ] **`POSTGRES_PASSWORD`** — the Railway Postgres password (reference variable), not `change_me`.
  - Services: Noey Api, Noey Worker. Test: same boot check as above.
- [ ] **`ADMIN_PASSWORD`** + **`SEED_EMAIL`** — there is no `ADMIN_EMAIL` variable; the
  first admin is seeded from `SEED_EMAIL` / `ADMIN_PASSWORD`
  (`scripts/migrate_to_multitenant.py`). `SEED_EMAIL` must be a REAL mailbox the owner
  reads: admin sign-in emails a 6-digit code to it (so email, section 2, must work first).
  - Services: Noey Api.
  - Test: sign in to Noey Dashboard with that address + password → a code arrives by email → dashboard opens.
- [ ] **`FRONTEND_URL`** = `https://<editor-host>` on **Noey Api** (CORS for the web editor and the wallet top-up return URL; see `docs/railway-deploy.md`).
- Not needed: `ENCRYPTION_KEY` — nothing reads it any more (`packages/auth/crypto.py` has no callers).

## 1. `SITE_URL` (links in every email, Stripe return URLs, Google callback base)

- [ ] **`SITE_URL`** = `https://<site-host>` (no trailing slash).
  - Services: **Noey Api**, **Noey Dashboard** (admin → marketing-site price revalidation).
  - Also: **`NEXT_PUBLIC_SITE_URL`** = the same value on **Noey Studio** (rebuild).
  - Why it matters: on a non-local deployment a `localhost` value keeps billing AND email off (503).
  - Test: after section 2, the reset-password email's link starts with `https://<site-host>/`.

## 2. Email — SendGrid (default) OR SMTP

Pick ONE transport. Both apply to **Noey Api** and **Noey Worker** (the worker sends the circuit-breaker alert).

### 2a. SendGrid (`EMAIL_TRANSPORT` unset or `sendgrid`)

- [ ] Authenticate the sending domain (SPF + DKIM) and add a DMARC record —
  https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication
- [ ] **`SENDGRID_API_KEY`** — restricted key, **Mail Send** only —
  https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys
- [ ] **`EMAIL_FROM_ADDRESS`** — an address on the authenticated domain. Optional `EMAIL_FROM_NAME` (default `Noey Studio`).
- [ ] **`CONTACT_TO_EMAIL`** — inbox for the contact form (unset → `/contact` answers 503).

### 2b. SMTP (`EMAIL_TRANSPORT=smtp`) — instead of 2a

- [ ] **`SMTP_HOST`**, **`SMTP_PORT`** (optional: 587 starttls / 465 ssl), **`SMTP_SECURITY`** (`starttls` default | `ssl`; `none` is refused unless the host is loopback),
  **`SMTP_USERNAME`** + **`SMTP_PASSWORD`** (both or neither) — from the provider's SMTP settings page
  (e.g. Google Workspace SMTP relay https://support.google.com/a/answer/2956491, Amazon SES SMTP https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html).
- [ ] `EMAIL_FROM_ADDRESS`, `CONTACT_TO_EMAIL` as in 2a; SPF/DKIM for that provider on the From domain.
- [ ] Turn the provider's **click tracking OFF** (SMTP has no per-message switch; tracking rewrites the one-time reset/verify links).

### Test (either transport)

1. `curl -X POST https://<api-host>/auth/forgot-password -H 'content-type: application/json' -d '{"email":"<your address>"}'` → **202**, not 503.
2. On the marketing site: sign up, resend verification, forgot password → reset, change email, contact form — each mail arrives.
3. In Gmail open one → "Show original": `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`, and the link is NOT rewritten by a tracking domain.
4. Delete a throwaway account (section 6 test) → the deletion confirmation mail arrives.

Full notes: `docs/email-sendgrid.md`.

## 3. Cloudflare Turnstile (bot check on sign-up / forgot password / contact / Google sign-up)

- [ ] Create a widget for `<site-host>` — https://developers.cloudflare.com/turnstile/get-started/
- [ ] **`NEXT_PUBLIC_TURNSTILE_SITE_KEY`** (public site key) → **Noey Studio** (rebuild).
- [ ] **`TURNSTILE_SECRET_KEY`** (secret) → **Noey Api**. Server check per https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Order: set the site key FIRST and deploy Noey Studio, then the secret — once the secret is set the API refuses register / forgot-password / contact / Google sign-UP without a token.
- Test: sign up on the site → widget shows, sign-up succeeds; `curl -X POST https://<api-host>/auth/register ... ` with no `turnstile_token` → **400 captcha**.
- Known gap: the web editor (`web/`) has no Turnstile widget, so while the secret is set a NEW user cannot sign UP with Google from the editor (they get `captcha_required`); existing users signing in are unaffected. New users should sign up on the marketing site.

## 4. Stripe (subscriptions + wallet top-up)

Full runbook: `docs/billing-stripe.md` §4–§9. Keys go on **Noey Api only** (the worker never calls Stripe).

- [ ] **`STRIPE_SECRET_KEY`** — a LIVE restricted key `rk_live_…` with the permissions in `docs/billing-stripe.md` §4 —
  https://docs.stripe.com/keys (restricted keys: https://docs.stripe.com/keys#create-restricted-api-secret-key)
- [ ] Seed live products/prices: `cd backend && .venv/bin/python scripts/stripe_seed.py --live` → prints the portal configuration id.
- [ ] **`STRIPE_PORTAL_CONFIGURATION_ID`** = that `bpc_…` — https://docs.stripe.com/customer-management/configure-portal
- [ ] Live webhook endpoint `https://<api-host>/billing/webhook` with the event list in `docs/billing-stripe.md` §6 — https://docs.stripe.com/webhooks
- [ ] **`STRIPE_WEBHOOK_SECRET`** = that endpoint's `whsec_…` signing secret. Billing stays OFF until both the key and this secret are set.
- [ ] Make sure `WALLET_MOCK_TOPUP` is unset (the API refuses to boot on a real host with it on).
- Test:
  1. `curl https://<api-host>/billing/plans` → live prices.
  2. Subscribe with a real card on the marketing site → `GET /billing/me` shows the plan; Stripe Dashboard → the webhook deliveries show 200.
  3. Wallet top-up → balance rises; refund it in Stripe → balance reversal arrives.
  4. Cancel in the portal → back to free at period end.
  5. Stripe's own go-live list: https://docs.stripe.com/get-started/checklist/go-live

## 5. Price revalidation secret (admin price edit → marketing site refresh)

- [ ] **`PRICES_REVALIDATE_SECRET`** — any long random value, the SAME on **Noey Dashboard** and **Noey Studio**.
- Test: change a plan price in Noey Dashboard → the pricing page on `<site-host>` shows the new amount within a minute (no redeploy). Without it the site only catches up on its next ISR revalidation.

## 6. Sign in with Google (marketing site + web editor)

Full runbook: `docs/google-sign-in.md`. Code cites the Google docs it follows
(`backend/packages/auth/google_oauth.py`):
https://developers.google.com/identity/openid-connect/openid-connect and
https://developers.google.com/identity/protocols/oauth2/web-server

- [ ] Google Cloud Console → Google Auth Platform / OAuth consent screen: app name "Noey Studio", support email, scopes `openid email profile`, **publish** the app (Testing mode only lets listed test users in) —
  https://support.google.com/cloud/answer/15549257
- [ ] Credentials → Create OAuth client ID → **Web application**. Authorized redirect URIs — register EXACTLY these (scheme, host, path, no trailing slash):
  - `https://<site-host>/auth/google/callback` (marketing site = `${NEXT_PUBLIC_SITE_URL}/auth/google/callback`)
  - `https://<editor-host>/auth/google/callback` (web editor = `${location.origin}/auth/google/callback`)
  - local only, optional: `http://localhost:3000/auth/google/callback`, `http://localhost:5174/auth/google/callback`
  - No "Authorized JavaScript origins" are needed (no Google JS library is loaded).
- [ ] **`GOOGLE_CLIENT_ID`** (`….apps.googleusercontent.com`) → **Noey Api**.
- [ ] **`GOOGLE_CLIENT_SECRET`** → **Noey Api** only (never a frontend).
- [ ] **`GOOGLE_REDIRECT_URIS`** → **Noey Api**: the same URIs, comma-separated, e.g.
  `https://<site-host>/auth/google/callback,https://<editor-host>/auth/google/callback`
- No variable is needed on Noey Studio or Noey Frontend: both ask `GET /auth/google/config` and show the button only when it says `enabled`.
- Redis on the API must be ≥ 6.2 (flow records use `GETDEL`); Railway's Redis is.
- Test:
  1. `curl https://<api-host>/auth/google/config` → `{"enabled":true,"redirect_uris":[...]}`.
  2. Marketing site `/signup` → "สมัครด้วย Google" with a fresh Google account → lands signed in; `/auth/me` shows `google_linked:true, has_password:false`.
  3. `/login` → "เข้าสู่ระบบด้วย Google" with the same account → signed in (no second account).
  4. A Google account whose address already has a VERIFIED password account → linked and signed in; an UNVERIFIED one → refused with "sign in with your password and link from settings".
  5. Web editor login → Google button → back in the editor signed in.
  6. Settings → เชื่อมต่อ Google / ยกเลิกการเชื่อมต่อ on both clients.
  7. Delete a Google-only throwaway account: profile → ลบบัญชี → "ยืนยันตัวตนด้วย Google" → deleted → signing in with Google again creates a NEW account.
  8. Press Cancel on Google's screen → back on login with "ยกเลิกการเข้าสู่ระบบด้วย Google แล้ว", no error page.
- Desktop app: no Google sign-in yet (needs a loopback/custom-scheme flow) — logged in `PARITY.md`.

## 7. Sentry (error monitoring) — one Sentry project per surface

A DSN is public by design (it can only submit events) —
https://docs.sentry.io/concepts/key-terms/dsn-explainer/ . Nothing is sent while a DSN is unset.

- [ ] Backend project (platform Python / FastAPI — https://docs.sentry.io/platforms/python/integrations/fastapi/):
  **`SENTRY_DSN`** → **Noey Api** AND **Noey Worker**. Optional: `SENTRY_TRACES_SAMPLE_RATE` (default 0 = errors only); `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` default to Railway's `RAILWAY_ENVIRONMENT_NAME` / `RAILWAY_GIT_COMMIT_SHA`.
  - Test: deploy log shows `monitoring_on` (not `monitoring_off reason="SENTRY_DSN is not set"`) on both services; trigger one error on a staging environment → the event has no request body, no Authorization/Cookie header, no email address.
- [ ] Web editor project (platform React — https://docs.sentry.io/platforms/javascript/guides/react/):
  **`VITE_SENTRY_DSN`** (optional `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE`) → **Noey Frontend** as build variables (the Dockerfile declares them as `ARG`s) → redeploy to rebuild. The CSP `connect-src` gains the DSN's ingest origin automatically.
  - Test: open the editor, run `throw new Error("sentry test")` from a `setTimeout` in the console → event appears; the page URL in it has its query masked.
- [ ] Marketing site project (platform Next.js — https://docs.sentry.io/platforms/javascript/guides/nextjs/):
  **`NEXT_PUBLIC_SENTRY_DSN`** (optional `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `…_RELEASE`, `…_TRACES_SAMPLE_RATE`) → **Noey Studio** → rebuild.
  - Test: same as the editor. Stack traces stay minified until source-map upload (`withSentryConfig` + `SENTRY_AUTH_TOKEN`) is added — not built.
- Not built: Sentry for **Noey Dashboard** (admin) and the desktop app (`@sentry/electron`).

## 8. Open registration (last)

- [ ] **`ALLOW_REGISTRATION=true`** on **Noey Api** — only after sections 2 and 3 pass: with the AI gate on
  (`REQUIRE_VERIFIED_EMAIL_FOR_AI`, default true) an account that never gets its verification mail can never use AI.
  Google sign-UP obeys the same switch.
- Test: sign up a fresh address on the marketing site → verification mail → verify → start a cut in the editor.

---

## What unset looks like (verified 2026-09-30, local API, no keys set)

| Request | Answer |
|---|---|
| API boot | starts; logs `monitoring_off reason="SENTRY_DSN is not set"` (worker: same) |
| `GET /auth/google/config` | 200 `{"enabled":false,"redirect_uris":[]}` — both frontends hide the button |
| `POST /auth/google/start`, `/auth/google/callback` | 503 `detail.code="not_configured"`, message names `GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URIS` (the frontends show generic Thai text instead) |
| `POST /auth/forgot-password`, `/auth/resend-verification`, `/contact` | 503 `email is not configured on this server (SENDGRID_API_KEY is not set)` |
| `EMAIL_TRANSPORT=smtp` without a host | 503 `... (SMTP_HOST is not set)`; `SMTP_SECURITY=none` on a remote host → `misconfigured ... only allowed for a local relay`; username without password → `SMTP_PASSWORD is not set` |
| `POST /auth/register` | 201 — registration works; the verification mail is skipped and logged |
| `POST /auth/delete-account` | works (204); the confirmation mail is skipped and logged. With a live Stripe subscription on record but Stripe unset → 503 `billing_unavailable` naming `STRIPE_SECRET_KEY` (the account is not deleted) |
