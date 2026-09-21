# Email with SendGrid — verification, password reset, email change, contact

Written 2026-09-21. Backend only: `backend/packages/email/` (transport +
templates), `backend/packages/auth/email_tokens.py` (single-use links),
`backend/services/api/routers/auth.py`, `backend/services/api/routers/contact.py`,
`backend/services/api/ratelimit.py`, `backend/services/api/ai_gate.py`.
Companion to `docs/billing-stripe.md`.

With `SENDGRID_API_KEY` / `EMAIL_FROM_ADDRESS` unset, every endpoint whose job
is to send mail answers **503** naming the missing variable. Registration still
succeeds and logs `verification_email_skipped`; login, refresh and the rest of
the API are unaffected.

---

## 1. What was built

| Flow | Endpoints | Mail |
|---|---|---|
| Verify the address | `POST /auth/register` (sends), `POST /auth/resend-verification`, `POST /auth/verify-email` | verification link, 48 h |
| Forgot password | `POST /auth/forgot-password`, `POST /auth/reset-password` | reset link, 60 min |
| Change email | `POST /auth/change-email`, then `POST /auth/verify-email` | confirmation to the NEW address (24 h) + heads-up to the OLD one |
| Contact form | `POST /contact` | to `CONTACT_TO_EMAIL`, Reply-To = visitor |
| Session revocation | `tv` claim in every JWT | — |
| AI gate | `current_user` + `services/api/ai_gate.py` | — |
| Rate limits | Redis fixed windows | — |

### Single-use links

`core.auth_tokens` stores only `sha256(token)` — the raw token (256 random
bits, URL-safe) exists only in the email. A token works while unused and
unexpired. Consuming it, or issuing a newer one of the same purpose, sets
`used_at`, so at most one link per purpose works at a time. Consumption locks
the row, so a link opened twice at once succeeds once. TTLs: verify 48 h,
reset 60 min, change_email 24 h.

Links: `{SITE_URL}/verify-email?token=…` (verification AND email-change
confirmation — the token carries its purpose) and `{SITE_URL}/reset-password?token=…`.
The site page reads the token and POSTs it to the API.

### Session revocation

Access and refresh tokens carry `tv` = `users.token_version` at issue time.
`current_user` (services/api/deps.py) and `POST /auth/refresh` reject a token
whose `tv` differs (401). A token without `tv` counts as 0 and the column
starts at 0 — every session issued before this shipped survives the deploy.
`POST /auth/change-password` and `POST /auth/reset-password` bump the version:
every earlier access and refresh token dies; both endpoints return fresh
tokens (change-password for the calling session's tenant).

### Existing accounts

The migration `01d8a4238d07` backfills `email_verified_at = created_at` for
every existing user (its only hand-written statement), so nobody is locked out
of AI features on deploy. The startup seed creates a fresh database's admin as
verified too.

### AI gate

With `REQUIRE_VERIFIED_EMAIL_FOR_AI=true` (default), an unverified, non-admin
account gets **403** `ยืนยันอีเมลก่อนใช้งาน AI — เปิดลิงก์ในอีเมลที่เราส่งให้ หรือกดส่งใหม่ได้ที่หน้าบัญชี`
from the endpoints that START paid AI work. The check runs in `current_user`,
before the endpoint body — so before any upload is stored, any project is marked
busy or any job queued — against ONE list, `services/api/ai_gate.py:AI_ROUTES`:

| Endpoint | Work it starts |
|---|---|
| `POST /videos` | server pipeline (speech-to-text + planning) |
| `POST /videos/{uid}/voiceover` | dub timeline planning |
| `POST /videos/{uid}/analyze-frames` | dub cut from frames |
| `POST /videos/{uid}/analyze-video` | dub cut from the video proxy |
| `POST /videos/{uid}/plan-dub` | synchronous model call |
| `POST /videos/{uid}/transcribe-audio` | speech-to-text + planning |
| `POST /videos/{uid}/reedit-dub-scenes` | re-edit pass |
| `POST /videos/{uid}/plan-effects` | effects placement |
| `POST /effect-styles` | style distillation |
| `POST /effect-styles/{uid}/regenerate` | style distillation |

Not gated (no paid AI): `POST /videos/local` (a project row),
`POST /videos/transcode` and `PUT /videos/{uid}/edit-timeline` (ffmpeg only),
everything else. The same policy (`packages/llm/usage.ai_access_problem`) also
runs in `check_limit` before every model call — the worker's included — as
defense in depth. A test fails if an `AI_ROUTES` entry stops matching a real
route; add new AI endpoints to the list.

---

## 2. SendGrid setup

### API key — restricted, Mail Send only

SendGrid → Settings → API Keys → Create API Key → **Restricted Access** (the
console calls it *Custom Access*) → **Mail Send: Full Access**, everything else
**No Access**. The key is shown once; put it in `SENDGRID_API_KEY` on the API
service (never in a file that is shared). A leaked Mail Send-only key can send
mail as you but cannot read contacts, change settings or create keys.

### Domain authentication (SPF + DKIM) — required

Settings → Sender Authentication → **Authenticate Your Domain**. Use a
subdomain you send from (e.g. `mail.example.com`), keep **automated security
ON**, and add the records SendGrid shows at your DNS provider: one CNAME
`emNNNN.` (SPF / return path) and two DKIM CNAMEs `s1._domainkey` /
`s2._domainkey`. Click *Verify* once DNS has propagated. Link branding is not
needed: click tracking is off (§3).

**DMARC.** SendGrid also proposes a `_dmarc` TXT record (`v=DMARC1; p=none;`).
Since 2024 Gmail and Yahoo require SPF, DKIM and a DMARC record from bulk
senders, and unauthenticated mail fares worse at every provider — publish one
from day one. Start with `p=none` plus a report
address (`rua=mailto:dmarc@yourdomain`), watch the reports for a few weeks, then
move to `p=quarantine` and eventually `p=reject` once only authenticated mail
uses the domain.

### Sender identity

`EMAIL_FROM_ADDRESS` must be on the authenticated domain (e.g.
`no-reply@mail.example.com` or `hello@example.com`), otherwise SendGrid refuses
with **403** and the API logs `email_rejected` with that hint. *Single Sender
Verification* works for a quick test, but a free-mailbox address (gmail.com,
hotmail.com…) as the From will fail DMARC at the receiver — don't ship it.
`EMAIL_FROM_NAME` defaults to "Noey Studio"; it is also the brand in the
templates. Replies go to the From address unless a mailbox exists there — use a
real inbox or accept that replies bounce.

### Tracking OFF (per message)

Every message sets `tracking_settings` explicitly, whatever the account
defaults are: `click_tracking {enable:false, enable_text:false}`,
`open_tracking {enable:false}`, `subscription_tracking {enable:false}`,
`ganalytics {enable:false}`. Click tracking would rewrite every link through a
tracking domain and Google Analytics tracking would append utm parameters —
neither may touch a one-time security link. You can also turn click/open
tracking off account-wide (Settings → Tracking); the per-message setting wins
either way.

### Transport

Plain httpx `POST https://api.sendgrid.com/v3/mail/send` (no SDK), JSON body,
`Authorization: Bearer <key>`, text/plain then text/html, categories
`noey-transactional` + the mail type. **202** = accepted. **429** and **5xx**
(and connection failures) are retried up to 3 attempts with backoff, honouring
`Retry-After` / `X-RateLimit-Reset` (capped at 8 s); 400/401/403/413 are final.
Logs never hold a full address (masked `b***@example.com` + a hash), a token
or a body; provider error text is redacted. Messages are not stored anywhere.

Which calls wait for the provider: resend-verification, change-email and
contact send while the request waits (a provider failure → 503, try again).
Registration and forgot-password send after the response (a failure is only
logged): registration never waits on the provider, and forgot-password's
response time does not reveal whether the account exists.

---

## 3. Templates (`packages/email/templates.py`)

Thai copy, minimal branded HTML with inline CSS (background `#f3f2f2`, text
`#201f1d`, accent `#b68235`, white card) plus a plain-text part. Table layout,
Thai-capable font stack, every dynamic value HTML-escaped, a copy-paste link
under each button. No AI vendor is named anywhere.

| Template | To | Subject |
|---|---|---|
| `verify_email` | the new account | ยืนยันอีเมลของคุณ — {brand} |
| `reset_password` | the account | ตั้งรหัสผ่านใหม่ — {brand} |
| `change_email_confirm` | the NEW address | ยืนยันอีเมลใหม่ของบัญชี — {brand} |
| `change_email_notice` | the OLD address | มีคำขอเปลี่ยนอีเมลของบัญชีคุณ — {brand} |
| `contact_message` | `CONTACT_TO_EMAIL` | [{brand}] ข้อความจากฟอร์มติดต่อ — {name} |

---

## 4. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SENDGRID_API_KEY` | unset | Mail Send-only restricted key. Unset → mail endpoints 503. |
| `EMAIL_FROM_ADDRESS` | unset | From address on the authenticated domain. Unset → 503. |
| `EMAIL_FROM_NAME` | `Noey Studio` | From name and template brand. |
| `CONTACT_TO_EMAIL` | unset | Contact-form inbox. Unset → `/contact` 503. |
| `REQUIRE_VERIFIED_EMAIL_FOR_AI` | `true` | The AI gate (§1). |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies in front of the API for client-IP resolution (§5). |
| `SITE_URL` | `http://localhost:3000` | Base of every link. On a non-local deployment a localhost value keeps email off (503), like billing. |
| `REDIS_URL` | (existing) | Rate-limit counters share the arq Redis. |
| `TURNSTILE_SECRET_KEY` | unset | When set, register / forgot-password / contact require a valid `turnstile_token` (400 otherwise). |

---

## 5. Rate limits

Fixed windows in Redis (`REDIS_URL`), key `noey:rl:<rule>:<sha256(identity)>:<window>`
with a TTL — no raw address or IP is stored. Per-email / per-account rules are
checked first; per-IP rules are secondary and looser (many people can share an
IP). The rules stop at the first refusal, so a refused request does not use up
the next rule's budget. **429** with a Thai detail (`ทำรายการถี่เกินไป …`) and a
`Retry-After` header (exposed to browsers via CORS). **Fail open:** if Redis is
unreachable the request is allowed, `rate_limit_store_unavailable` is logged,
and Redis is skipped for 30 s.

| Endpoint | Rule | Limit |
|---|---|---|
| `POST /auth/login` | email + IP | 10 / 15 min |
| `POST /auth/login` | IP | 100 / 15 min |
| `POST /auth/register` | email | 5 / hour |
| `POST /auth/register` | IP | 20 / hour |
| `POST /auth/forgot-password` | email | 3 / hour |
| `POST /auth/forgot-password` | IP | 20 / hour |
| `POST /auth/resend-verification` | account | 3 / hour |
| `POST /auth/resend-verification` | IP | 20 / hour |
| `POST /auth/change-email` | account | 5 / hour |
| `POST /auth/change-email` | IP | 20 / hour |
| `POST /auth/change-password` | account | 10 / 15 min |
| `POST /contact` | visitor email | 3 / hour |
| `POST /contact` | IP | 10 / hour |

Values live in `services/api/ratelimit.py` (one line each).

### Client IP and `TRUSTED_PROXY_HOPS`

Default (0): the socket peer. With N > 0 the API takes the Nth
`X-Forwarded-For` entry from the right — the last address no client could
forge, since each proxy appends the address it received the connection from —
and falls back to the leftmost entry when the chain is shorter than N.

**Railway: `TRUSTED_PROXY_HOPS=1`.** Railway's edge proxy is the one hop in
front of a service; Railway staff state it writes the connecting client into
`X-Forwarded-For` and that clients cannot overwrite it (Railway has not
documented this formally and its behaviour has changed before — re-check after
platform changes). The marketing site's server (the Next.js BFF) should call
the API over Railway's **private network** (`http://<api-service>.railway.internal:<PORT>`)
and set `X-Forwarded-For: <visitor IP>`: with no edge in that path the API sees
exactly one entry, the visitor. If the BFF calls the public domain instead, the
edge replaces what it sent, every BFF request shares the BFF's egress IP, and
only the per-email / per-account rules stay meaningful. If Railway's CDN is
ever enabled on the API domain, it adds a hop: use 2.

---

## 6. API reference (for the marketing site)

JSON everywhere; errors are FastAPI's `{"detail": …}`; auth is `Authorization: Bearer <access_token>`.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /auth/register` | unchanged | 201 TokenOut; verification mail sent after the response | 403 · 409 · 422 · 400 captcha · 429 |
| `GET /auth/me` | — | adds `email_verified: bool` | 401 |
| `POST /auth/resend-verification` | — (auth) | 202 `{}` | 409 already verified · 429 · 503 |
| `POST /auth/verify-email` | `{token}` | 200 `{email, purpose: "verify_email"\|"change_email"}` | 400 invalid/expired/used · 409 new address taken at confirm time (link stays usable) |
| `POST /auth/forgot-password` | `{email, turnstile_token?}` | ALWAYS 202 `{}` | 422 malformed email · 400 captcha · 429 · 503 email not configured |
| `POST /auth/reset-password` | `{token, new_password}` | 200 TokenOut (revokes other sessions, marks verified) | 400 invalid link · 422 weak password |
| `POST /auth/change-password` | `{current_password, new_password}` | **200 TokenOut** (was 204; revokes other sessions) | 400 wrong current · 422 · 429 |
| `POST /auth/change-email` | `{new_email, current_password}` (auth) | 202 `{}` | 400 wrong password · 409 taken / same as current · 422 · 429 · 503 |
| `POST /contact` | `{name ≤100, email, message 10–4000, turnstile_token?, company?}` | 202 `{}` (filled `company` honeypot: 202, nothing sent) | 422 · 400 captcha · 429 · 503 |

Confirming an email change also voids reset links mailed to the old address,
and (when billing is configured) moves the Stripe customer's email so receipts
follow the account.

---

## 7. Owner checklist

1. SendGrid account → authenticate the sending domain (§2), add DMARC `p=none` + `rua`.
2. Restricted API key (Mail Send only) → `SENDGRID_API_KEY` on the Railway **api** service.
3. `EMAIL_FROM_ADDRESS` (on that domain), `EMAIL_FROM_NAME`, `CONTACT_TO_EMAIL`, `SITE_URL`.
4. `TRUSTED_PROXY_HOPS=1` on the api service; have the BFF call the API over the private network with `X-Forwarded-For`.
5. Deploy — migration `01d8a4238d07` runs at startup and grandfathers existing accounts.
6. Send yourself each mail once (register, resend, forgot, change email, contact) and check Gmail's "Show original" for `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`, and that links are NOT rewritten.
7. Decide `REQUIRE_VERIFIED_EMAIL_FOR_AI` (default on).
8. Open registration (`ALLOW_REGISTRATION=true`) only AFTER step 6 works: with
   the AI gate on, an account that cannot receive its verification mail can
   never use AI (existing accounts are unaffected — they were grandfathered).

## 8. Not built / known limits

- **Expired token rows** are never deleted (tiny rows; a periodic `DELETE … WHERE expires_at < now() - interval '7 days'` could join the worker's `sweep_housekeeping`).
- **No bounce/complaint handling** (SendGrid Event Webhook): a mistyped address simply never verifies.
- **Email change does not revoke sessions** (only password change/reset does).
- **Mail sent after the response** (registration, forgot-password) runs in the API process; a crash at that moment loses the mail — the user can resend / request again.
- **Rate limits are fixed windows**, not sliding ones: a burst that straddles a window edge can briefly reach up to 2× a limit.
- **No live SendGrid call was made** during development — all tests use `httpx.MockTransport` / a fake mailer. Do checklist step 6 before launch.
