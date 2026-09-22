# Token billing & usage limits — implementation plan

Status: **planned, not built** (owner-approved decisions 2026-09-22). Today the backend still
counts raw vendor tokens against a per-UTC-day cap (`settings.plan_token_limit`,
`packages/llm/usage.py:_period_start`). Start after the frontend redesign lands.

## 1. The unit

- Users see one unit internally called **token**, but the UI shows **percentages only**
  (never token counts), Claude-style, with English labels: `5-hour limit`, `Weekly limit`,
  `Monthly limit`.
- Cost peg: **1M tokens = ฿50 vendor cost** at 2027 reference prices and ฿34.5/USD.
  Real cost today ≈ ฿33/1M (Gemini Flash is half price until 2026-12-31).
- **Sell price: ฿250 per 1M tokens, same for every plan.**

### Rate card v1 (fixed; changes only as a new version, forward-only)

| Resource | Our tokens |
|---|---|
| Gemini Flash (3.7 / 3.8) input | 1.035 per vendor token |
| Gemini Flash output (incl. thinking) | 5.175 per vendor token |
| Gemini 3.1 Pro input (prompt ≤200k / >200k) | 1.38 / 2.76 |
| Gemini 3.1 Pro output (≤200k / >200k) | 8.28 / 12.42 |
| Cached input | 10% of that model's input rate |
| ElevenLabs Scribe v2 (pay-as-you-go $0.22/h + $0.05/h keyterms) | 51.75 per billed audio second |

Formula per call: `tokens = ceil(Σ vendor_units × rate)`. Users are charged by the rate card;
real cost (`cost_thb`, from the admin's live vendor price table + FX) is recorded separately,
so FX or vendor price moves change only our margin, never how fast a user's limit drains.

## 2. Plans and limits

| Plan | ฿/month | vs Lite | Monthly budget | User-visible limits | Concurrent AI jobs |
|---|---|---|---|---|---|
| Free | 0 | — | 0.1M | Monthly | 1 |
| Lite | 199 | 1x | 0.8M | Weekly | 1 |
| Starter | 399 | 2x | 1.6M | Weekly | 1 |
| Pro | 990 | 5x | 4M | Weekly + 5-hour | 2 |
| Studio | 1,990 | 10x | 8M | Weekly + 5-hour | 3 |
| Agency | 3,990 | 20x | 16M | Weekly + 5-hour | 4 |
| Max | 6,990 | 35x | 28M | Weekly + 5-hour | 5 |

- Weekly = monthly ÷ 4.33. 5-hour = 40% of weekly. Windows start at first use (rolling).
- Limits are checked at job START; a started job finishes (bounded by the per-job ceiling below).
- Extra jobs beyond the concurrency cap wait in a queue instead of failing.
- Tokens are refunded when a job fails because of us; the vendor cost stays on our books.

## 3. Cost recording (fix before anything else)

Audit 2026-09-22: all 8 production Gemini call sites go through `packages/llm/gateway.py`
and every worker task / the sync `/plan-dub` route sets a `UsageCtx`; the 3 STT sites record
billed seconds. Gaps to close:

1. Record every request that reached the vendor, including failed attempts and retries
   (`status`: ok / failed / retry). Failed-because-of-us attempts cost us, not the user.
2. STT: record per file as soon as it is transcribed (not only when the whole batch succeeds),
   with a `keyterms` flag.
3. Store `cached_tokens` from Gemini usage.
4. Recording must be awaited/durable (outbox or retry), not fire-and-forget with a swallowed error.
5. New columns on usage rows: `tokens`, `cost_thb`, `rate_version`, `status`, `job_id`.
   Migrations via `alembic revision --autogenerate` only.
6. Admin reconciliation: monthly system total vs real Google / ElevenLabs invoices; warn when
   the gap exceeds 5% (dev scripts in `backend/scripts/` are unattributed owner cost).

## 4. Three guard layers

1. **Pre-flight estimate + reservation.** In the wizard, as soon as files are chosen
   (duration known client-side): estimate from mode, precision and duration (video ≈ 100 tok/s
   standard, 300 high, × rate; STT seconds × 51.75; + prompt + max output). Show
   "uses about 18% of your Weekly limit"; block before upload when it does not fit.
   On start, atomically reserve the estimate (DB row lock / Redis Lua) so parallel jobs cannot
   overspend. On finish, settle to actual and release the difference.
2. **Per-call guard in the gateway.** Before each AI call: `spent_in_job + this_call_max`
   (input counted before sending, output bounded by `max_output_tokens` + thinking budget,
   STT known from audio length) must stay within the job ceiling = reservation × 1.2.
   Otherwise do not send; stop the job ("stopped: limit reached") and cancel its remaining
   worker steps. A sent call cannot be stopped midway, so the maximum overshoot is one call.
   If this fires, charge the user only the reservation; log estimate vs actual.
3. **System-wide circuit breaker.** Daily total spend cap (admin-configurable) checked in the
   gateway; when hit, refuse new jobs and alert the admin. Plus vendor-side caps: Google Cloud
   budget alerts / API key quotas, ElevenLabs prepaid balance without auto top-up.

## 5. Surfaces

- `GET /usage/me`: percentages + reset times per window, plan, concurrency; never token counts.
- Web editor: settings page meters, wizard estimate, clear "limit reached · Resets 2:30 PM".
  Desktop uses the same backend (enforced automatically); its UI gap goes in `PARITY.md`.
- noey-frontend account pages: the same meters.
- Admin: real tokens + ฿ cost per user/job; cost per 1M and margin per 1M; editable
  rate-card reference (฿50) and sell price (฿250); correct default vendor prices
  (Flash $0.75/$3.75 until 2026-12-31 then $1.50/$7.50; 3.1 Pro $2/$12, $4/$18 above 200k;
  Scribe v2 $0.22/h + $0.05/h keyterms); STT card becomes per-hour pay-as-you-go;
  per-user reset of the 5-hour / weekly window (audited); daily circuit-breaker setting;
  reconciliation view.

## 6. Owner decisions added 2026-09-22

- **Stripe**: build the plan-change logic now (upgrade = higher limits immediately, downgrade =
  next cycle, cancel = until period end then Free, payment failed = 3-day grace then Free);
  wire it to live Stripe later.
- **Admin / internal accounts have no limits** (usage and cost still recorded).
- **Free-tier abuse**: rate-limit sign-ups and free usage per IP (and device where possible),
  on top of email verification + Turnstile.
- **Storage per plan follows the frontend copy**: Free 1 GB, Lite 3, Starter 5, Pro 10,
  Studio 30, Agency 60, Max 100 GB — enforce in the backend.
- **Reset times render in the viewer's own timezone** (API returns UTC ISO; the browser formats).
- **Desktop**: any web change that ADDS a feature ships on desktop too (not only a PARITY note).
- **Estimate accuracy**: store estimate vs actual per job on the user's usage record; show it
  in the admin per user and in aggregate.
- **FX rate**: fetch automatically (daily) with a manual override in the admin.
- **Vendor rate limits**: a system-wide queue/semaphore per vendor (RPM/TPM for Gemini,
  concurrency for ElevenLabs) so bursts wait instead of failing.
- **VAT**: owner is an individual below the ฿1.8M/year VAT threshold → NOT VAT-registered.
  Prices are not VAT-inclusive for accounting (admin "ราคารวม VAT" off); Stripe receipts are
  enough; no tax invoices. Revisit when revenue approaches ฿1.8M/year.
- **Top-up (pay-as-you-go "extra usage")**: the user sees a **baht balance**, never tokens.
  Price ฿350 per 1M tokens (40% above the subscription's ฿250). Packs ฿100 / ฿300 / ฿500 /
  ฿1,000; PromptPay offered first (1.65% vs card 3.65% + ฿10). Balance valid 12 months.
  Consumed only after the plan's windows are exhausted (or for Free users with no plan left),
  so hitting a limit becomes "continue with your balance" instead of a dead end. Deduction per
  call = tokens × ฿350 / 1M, shown as "เหลือ ฿xx.xx". Refunds on our failures return baht.
  Top-up usage still passes guard layers 2 and 3.

## 7. Tests

Rate-card conversion, window math (rolling start, resets), reservation races, per-call guard
stop, refunds, concurrency queue, circuit breaker, and admin/user endpoint security.

## 8. Plan features promised by the website (source of truth: noey-frontend `lib/plans.ts`)

Owner rule (2026-09-22): where the backend or editor does not match what the pricing page
promises, change the product to match the website. Follow-up pass AFTER the token workflow and
the website redesign land (re-read the final `lib/plans.ts` first — the redesign may reword it).
Gaps found 2026-09-22:

| Promise | Free | Lite | Starter | Pro | Studio | Agency | Max | Enforced today? |
|---|---|---|---|---|---|---|---|---|
| Footage per project | 5 min | 10 min | 20 min | 2 h | 2 h | 2 h | 2 h | No |
| Projects kept on the account | 3 | 10 | 20 | unlimited | unlimited | unlimited | unlimited | No |
| Storage | 1 GB | 3 GB | 5 GB | 10 GB | 30 GB | 60 GB | 100 GB | Wrong values (Free 10, Starter 10) |
| Background music | — | yes | yes | yes | yes | yes | yes | No (everyone has it) |
| Auto-convert files the browser can't open | — | — | yes | yes | yes | yes | yes | No (everyone has it) |
| Processing queue priority | normal | normal | normal | ahead | first | first | first | No |
| All modes, Thai subtitles, dub mode + script, unlimited timeline edits/re-renders | all plans | | | | | | | Yes |

Enforce server-side (API + worker) and show the matching state in web + desktop (hide/lock the
control with an upgrade hint, block uploads over the footage/project limit before upload).
