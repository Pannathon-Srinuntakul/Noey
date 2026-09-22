# Token billing — implementation design

Status: **built** (2026-09-22) — CORE-A §18, CORE-B §19, admin §20, editor §21, review fixes §22. Maps `docs/token-billing-plan.md` (owner-approved, the
source of every number below) onto this codebase. Implementers: read the plan first, then this.
If you must deviate, edit this file and say why in §15 "Deviations log".

Hard constraints restated: no git; no deploy; migrations only via `alembic revision
--autogenerate` (scratch DB in the pre-change state if needed; hand-write only data backfills and
say so); no vendor names and **no token counts** in any user-visible string; limit labels are
English (`5-hour limit`, `Weekly limit`, `Monthly limit`); reset times leave the API as UTC ISO and
are formatted by the viewer's browser; `noey-frontend/` is off-limits (see §9.1 for the fields it
reads, which must keep working).

---

## 0. Current state (what exists, what changes)

| Area | Today | Change |
|---|---|---|
| Limit | `check_limit` in `packages/llm/usage.py`: raw vendor tokens per **UTC day**, `settings.plan_token_limit`, checked before **every** call | Rate-card tokens, rolling 5h/weekly/monthly windows, checked at **job start** with a reservation; per-call guard is a job-ceiling check only |
| Recording | `record_usage` via `asyncio.ensure_future` (fire-and-forget, errors swallowed); only successful calls | Awaited, retried, Redis outbox fallback; every attempt that reached the vendor, with `status` |
| STT | `_record_stt(transcript)` once per run after the whole batch (`services/worker/tasks.py:86`) | One row per clip as soon as it is billed, `keyterms` flag |
| Job identity | `core.jobs.id` is deterministic and **reused** per project (`vlocal_<uid[:8]>`) | New `core.ai_runs` row per paid run (`run_id`); usage rows carry both `run_id` and `job_id` |
| Cost | `MODEL_PRICES` in `usage.py` (stale), admin `cost_config` (stale defaults, STT as package) | Vendor price table in admin `cost_config` (correct defaults, dated schedule, per-hour STT), FX store, `cost_thb` per row |
| Storage | Enforced on `PUT /videos/{uid}/files/*` via `settings.plan_storage_limit` | Values fixed to 1/3/5/10/30/60/100 GB; admin unlimited; included in `/usage/me` |
| Admin exempt | `enterprise` plan = 0 = unlimited | `is_admin` OR `enterprise` = unlimited (still recorded) |

All 8 production model call sites use `gateway.acompletion_stream_thinking`
(`dub_ai.py` ×3, `speech_select.py`, `effects_ai.py`, `effects_style.py`, `cut_style.py`,
plus `plan_core.py` Haiku passes via `acompletion`). STT: `elevenlabs_stt.run_transcription`
called from `transcribe_video`, `plan_talking_local`, `plan_speech_local`.

---

## 1. Module layout

| New / changed module | Owns |
|---|---|
| `packages/billing/rate_card.py` (new) | Versioned rate card, `tokens_for_llm`, `tokens_for_stt`, `CURRENT_RATE_VERSION` |
| `packages/billing/limits.py` (new) | `PLAN_LIMITS` table (monthly budget, windows, concurrency, storage), `is_unlimited(user)` |
| `packages/billing/estimate.py` (new) | `MODE_PROFILES`, `estimate_run(...)`, `ESTIMATOR_VERSION` |
| `packages/billing/vendor_cost.py` (new) | `cost_thb_for_llm/stt` from admin `cost_config` + FX (cached 60 s) |
| `packages/billing/fx.py` (new) | Fetch + store + resolve the USD→THB rate |
| `packages/billing/metering.py` (new) | Durable usage-row writes, outbox, `run.actual_tokens` accrual |
| `packages/billing/runs.py` (new) | Reserve / start (slot) / settle / refund / stop; window math; row locks |
| `packages/billing/guard.py` (new) | Per-call guard (`before_llm_call`, `before_stt_clip`), stop flags, circuit breaker |
| `packages/billing/vendor_limits.py` (new) | Redis Lua token buckets (Gemini RPM/TPM) + lease semaphore (ElevenLabs) |
| `packages/billing/wallet.py` (new) | Lots, ledger, top-up credit, reserve/debit/refund, expiry |
| `packages/billing/plan_change.py` (new) | Stripe-independent upgrade / downgrade / cancel / payment-failed / grace |
| `packages/billing/free_tier.py` (new) | Per-IP / per-device free-tier limits (Redis, fail-open) |
| `packages/billing/topup.py` (new) | Stripe Checkout one-time (PromptPay/card) + mock path |
| `packages/llm/usage.py` | Keeps `UsageCtx` (+ `run_id`, `job_id`, in-process spend tracker), token extraction (+ cached). `check_limit`, `record_usage`, `record_stt_usage`, `_period_start`, `MODEL_PRICES`, `estimate_cost_usd` removed/redirected |
| `packages/llm/gateway.py` | Calls `guard.before_llm_call` → vendor limiter → send → `metering.record_llm_attempt` (awaited) per attempt |
| `packages/video/elevenlabs_stt.py` | `run_transcription(..., on_clip_billed=, before_clip=)` callbacks; limiter around `_post_stt`. Billing imports stay **lazy** (sidecar imports `packages/video`) |
| `packages/video/stt_pricing.py` | Credits model retired (pay-as-you-go now); keep only for historical rows or delete after admin migrates |
| `packages/admin/cost_config.py` | New defaults, dated price schedule, >200k tier, cached ratio, STT per hour |
| `packages/admin/metrics.py` | Drops `_period_start`/daily quota; adds rate-card tokens, cost_thb, margin, accuracy |
| `services/api/routers/usage.py` | New `/usage/me` shape, `POST /usage/estimate` |
| `services/api/routers/wallet.py` (new) | `/wallet/me`, `/wallet/checkout`, mock complete |
| `services/api/routers/admin.py` | Window reset, reconciliation, accuracy, FX, billing config, breaker |
| `services/api/routers/billing.py` + `packages/billing/webhooks.py` | Top-up events (`mode=payment`) |
| `services/api/billing_start.py` (new) | `start_paid_run(...)` helper every AI route calls (reserve + free-tier + breaker) |
| `services/worker/tasks.py` | `run_id` kwarg on every AI task; slot acquire; settle in `finally`; per-clip STT; new crons |

---

## 2. Rate card (`packages/billing/rate_card.py`)

```python
@dataclass(frozen=True)
class LlmRate: input: float; output: float; input_long: float | None; output_long: float | None; long_threshold: int | None
@dataclass(frozen=True)
class RateCard: version: str; llm: dict[str, LlmRate]; cached_ratio: float; stt_per_sec: float
RATE_CARDS = {"v1": RateCard("v1",
    llm={"flash": LlmRate(1.035, 5.175, None, None, None),
         "pro":   LlmRate(1.38, 8.28, 2.76, 12.42, 200_000)},
    cached_ratio=0.10, stt_per_sec=51.75)}
CURRENT_RATE_VERSION = "v1"   # forward-only: a change is a new key, never an edit
```

- `family_for(model)`: `"flash"` in id → flash; `"pro"` in id → pro; **unknown → pro** (dearer guess, same rule as `stt_pricing._FALLBACK`). Strip `gemini/` prefix.
- `tokens_for_llm(model, input, cached, output, version=CURRENT)` = `ceil((input−cached)×in + cached×in×0.10 + output×out)`; long tier when `input > long_threshold` (whole call at long rate, as Gemini bills).
- `tokens_for_stt(billed_sec)` = `ceil(billed_sec × 51.75)` (keyterms surcharge is inside the 51.75; the flag affects `cost_thb` only).
- Sell constants (code, not DB): `SELL_SATANG_PER_1M = 25_000`, `TOPUP_SATANG_PER_1M = 35_000`, `REFERENCE_COST_SATANG_PER_1M = 5_000`. Admin can edit the *display* reference/sell (§9.5) but deduction uses the code constant.

---

## 3. Schema (all `core` schema; one autogenerated migration per implementer)

### 3.1 `llm_usage_logs` (changed)

| Column | Type | Notes |
|---|---|---|
| `run_id` | String(32) FK `ai_runs.id` SET NULL, null, indexed | null for scripts / legacy rows |
| `job_id` | String(64) null | `core.jobs.id` at the time |
| `status` | String(16) not null, server_default `'ok'` | `ok` / `failed` / `retry` (retry = a failed attempt that was retried) |
| `cached_tokens` | Integer default 0 | from `prompt_tokens_details.cached_tokens` / Gemini `cachedContentTokenCount` |
| `tokens` | BigInteger default 0 | rate-card tokens for this row |
| `rate_version` | String(16) null | e.g. `v1` |
| `cost_thb` | Numeric(12,4) null | vendor cost at record time (price table + FX) |
| `fx_rate` | Numeric(10,4) null | FX used for `cost_thb` (reconciliation) |
| `idem_key` | String(36) unique, null | outbox idempotency |

Index `(user_id, created_at)` and `(run_id)`. Legacy rows: `tokens`/`cost_thb` null; a **data backfill** (hand-written, stated) may compute `tokens` with v1 for admin history — optional, CORE-A decides.

### 3.2 `stt_usage_logs` (changed)

Add `run_id`, `job_id`, `status`, `tokens`, `rate_version`, `cost_thb`, `fx_rate`, `idem_key` (as above) + `keyterms` Boolean default false + `clip_index` Integer null. `audio_sec` becomes per clip.

### 3.3 `ai_runs` (new) — one paid run = reservation + estimate vs actual

| Column | Type | Notes |
|---|---|---|
| `id` | String(32) PK | uuid4 hex = `run_id` |
| `user_id`, `tenant_id` | BigInteger FK CASCADE | |
| `job_id` | String(64) null | |
| `reference_id` | String(64) null | project / style uid |
| `kind` | String(32) | `analyze_video`, `analyze_frames`, `transcribe_audio`, `plan_dub`, `reedit`, `plan_effects`, `distill_style`, `server_pipeline`, `voiceover` |
| `mode`, `engine`, `precision` | String(32) null | estimator inputs |
| `media_sec` | Float default 0 | seconds the estimate used |
| `estimate_tokens` | BigInteger | |
| `reserved_tokens` | BigInteger | part held against plan windows |
| `reserved_wallet_satang` | BigInteger default 0 | part held against wallet |
| `ceiling_tokens` | BigInteger | `ceil(estimate × 1.2)` |
| `actual_tokens` | BigInteger default 0 | accrued per recorded row (same txn) |
| `charged_tokens` | BigInteger null | set at settle (windows part) |
| `charged_wallet_satang` | BigInteger null | set at settle |
| `status` | String(16) | `queued` → `running` → `settled` / `stopped` / `refunded` / `cancelled` / `released` |
| `outcome` | String(48) null | `ok`, `limit_stop`, `our_failure`, `user_cancel`, `user_error`, `orphaned` |
| `unlimited` | Boolean | admin/internal: nothing held, nothing charged, still recorded |
| `estimator_version`, `rate_version` | String(16) | |
| `created_at`, `started_at`, `lease_until`, `settled_at` | timestamptz | `lease_until` = slot heartbeat |

Indexes: `(user_id, status)`, `(created_at)`.

### 3.4 `usage_accounts` (new) — one row per user, the lock target

| Column | Type | Notes |
|---|---|---|
| `user_id` | BigInteger PK FK CASCADE | created lazily (`INSERT … ON CONFLICT DO NOTHING`) |
| `five_hour_started_at`, `five_hour_used` | timestamptz null, BigInteger 0 | |
| `weekly_started_at`, `weekly_used` | same | |
| `monthly_started_at`, `monthly_used` | same | Free only is *enforced*; always tracked |
| `reserved_tokens` | BigInteger 0 | sum of open reservations |
| `wallet_balance_satang` | BigInteger 0 | cache of Σ lot remaining (not expired) |
| `wallet_reserved_satang` | BigInteger 0 | |
| `pending_plan`, `pending_plan_at` | String(32) null, timestamptz null | downgrade / cancel scheduled |
| `grace_until` | timestamptz null | payment-failed grace |
| `updated_at` | timestamptz | |

`users.usage_reset_at` stays (unused by new code) until admin UI migrates; drop in CORE-B's migration after removing readers.

### 3.5 Wallet (new)

`wallet_lots`: `id` BigInt PK, `user_id`, `source` (`stripe`/`mock`/`admin`/`refund`), `amount_satang`, `remaining_satang`, `expires_at` (purchase + 365 d), `stripe_session_id` String(255) **unique** null (idempotent credit), `payment_method` String(16) null, `created_at`.

`wallet_ledger`: `id`, `user_id`, `lot_id` null, `run_id` null, `kind` (`purchase`/`debit`/`refund`/`expire`/`adjust`), `amount_satang` (signed), `balance_after_satang`, `note` String(200) null, `actor_user_id` null (admin adjust), `created_at`. Index `(user_id, created_at)`.

### 3.6 FX + reconciliation (new)

`fx_rates`: `id`, `rate_date` Date, `usd_thb` Numeric(10,4), `source` String(32), `fetched_at`; unique `(rate_date, source)`.
`vendor_invoices`: PK `(month String(7), vendor String(16))`, `amount_thb` Numeric(12,2), `note`, `updated_by`, `updated_at`.

### 3.7 `admin_settings` keys (JSON, no migration)

| Key | Shape |
|---|---|
| `cost_config` (changed) | §7 |
| `fx_override` | `{"usd_thb": 35.1 \| null}` |
| `billing_config` | `{"reference_thb_per_1m": 50, "sell_thb_per_1m": 250}` display/margin only |
| `circuit_breaker` | `{"enabled": true, "daily_cap_thb": 3000, "hard_stop_ratio": 1.25, "alert_email": null}` |

### 3.8 `users` (changed)

`signup_ip_hash` String(64) null, `signup_device_hash` String(64) null (§12).

---

## 4. Plan limits (`packages/billing/limits.py`)

```python
@dataclass(frozen=True)
class PlanLimits: monthly: int; windows: tuple[str, ...]; concurrency: int; storage_gb: int
WEEKS_PER_MONTH = 4.33; FIVE_HOUR_SHARE = 0.40
PLAN_LIMITS = {
 "free":    PlanLimits(100_000,    ("monthly",),             1, 1),
 "lite":    PlanLimits(800_000,    ("weekly",),              1, 3),
 "starter": PlanLimits(1_600_000,  ("weekly",),              1, 5),
 "pro":     PlanLimits(4_000_000,  ("weekly", "five_hour"),  2, 10),
 "studio":  PlanLimits(8_000_000,  ("weekly", "five_hour"),  3, 30),
 "agency":  PlanLimits(16_000_000, ("weekly", "five_hour"),  4, 60),
 "max":     PlanLimits(28_000_000, ("weekly", "five_hour"),  5, 100),
}
```

- `weekly_limit = floor(monthly / 4.33)`; `five_hour_limit = floor(weekly × 0.40)`; `monthly_limit = monthly`. Window lengths: 5 h, 7 d, 30 d.
- Unknown plan → free. `enterprise` or `user.is_admin` → `is_unlimited` (no windows, no concurrency cap beyond 5 for vendor safety, storage unlimited, breaker does not block).
- `settings.plan_*_monthly_tokens`/`plan_token_limit` removed; `settings.plan_*_storage_bytes` defaults changed to 1/3/5/10/30/60/100 GB and `plan_storage_limit` reads `PLAN_LIMITS` unless an env override is set (keep env hook). Payment-failed grace / pending plan resolution happens in `effective_plan(user, account, now)`.

### Window math (`runs.py`)

- Window *w* is **active** iff `started_at is not None and now < started_at + length(w)`. Inactive → treated as `used = 0`; it (re)starts at the next reservation (`started_at = now`, `used = 0`).
- `headroom(w) = limit(w) − used(w) − reserved_tokens` (reservations count against every enforced window).
- `resets_at(w) = started_at + length(w)` when active, else null (UI: "resets 5 h after next use").
- Charges at settle go to all tracked windows (5h, weekly, monthly), starting any that are inactive.

---

## 5. Estimator (`packages/billing/estimate.py`)

Runs **server-side only**. The wizard calls `POST /usage/estimate` with durations; every start route recomputes from server-known durations (`ProxyManifestEntry.durationSec`, `local_meta.clips[].durationSec`, `PlanDubIn.clipDurations`, WAV `media_duration`) — the client number is never trusted for the reservation.

```
video_in   = Σ clip_sec × (100 if precision=="standard" else 300)       # plan §4.1
stt_tokens = ceil(Σ audio_sec × 51.75)                                  # modes that transcribe
llm_tokens = ceil((video_in + P.prompt_in + P.transcript_per_sec × audio_sec) × rate.in
                  + P.max_output × rate.out) × P.calls
estimate   = llm_tokens + stt_tokens
```

`MODE_PROFILES[kind]` (per-kind constants, versioned by `ESTIMATOR_VERSION = "e1"`): `prompt_in`, `max_output` (output + thinking cap actually sent — see §6.2), `transcript_per_sec`, `calls`, `uses_video`, `uses_stt`, `model_for(engine)` via `quality.resolve`. Initial values: CORE-A derives them with a one-off `backend/scripts/usage_profile.py` (p50/p99 of `input_tokens`/`output_tokens` per `feature`×`model` from existing rows) and writes the numbers + date into the module docstring.

| kind (mode) | video | STT | notes |
|---|---|---|---|
| `analyze_video` (dub_first/highlight) | yes | no | engine+precision |
| `analyze_frames` | frames: `n_frames × 258` | no | |
| `transcribe_audio` (talking_head, speech_*) | proxies if sent | yes | + planning pass |
| `plan_dub` | no | no | transcript-sized text |
| `reedit` | yes (proxy) | no | |
| `plan_effects` | cut proxy | no | desktop only for now |
| `distill_style` | reference clip | no | |
| `server_pipeline` / `voiceover` | per server chain | yes | |

Output of `estimate_run`: `Estimate(tokens, ceiling, media_sec, kind, model, estimator_version, rate_version)`.

**Measured profiles (CORE-A, 2026-09-22, `scripts/usage_profile.py --days 365` on the development DB —
the only real usage so far; re-measure on production and bump `ESTIMATOR_VERSION`):**

| feature × model | n | input p50 / p99 | output p50 / p90 / p99 |
|---|---|---|---|
| video_cut × gemini-3.8-flash (dub, video) | 468 | 27,136 / 120,524 | 2,522 / 3,254 / 24,869 |
| video_cut × gemini-3.7-flash | 1,144 | 1,227 / 29,336 | 412 / 511 / 3,148 |
| video_effects × gemini-3.1-pro-preview | 272 | 30,988 / 35,905 | 1,607 / 1,852 / 1,916 |
| video_style × gemini-3.1-pro-preview | 31 | 45,635 / 57,285 | 900 / 900 / 900 |
| STT file (scribe_v2) | 552 | 211 s p50, 422 s p99 | — |

`MODE_PROFILES` e1 (`prompt_in` / `max_output` / calls): analyze_video, analyze_frames, reedit 6,000 / 8,000 / 1;
plan_dub, voiceover 8,000 / 4,000 / 1; transcribe_audio, server_pipeline 4,000 + 15 tok per audio second /
4,000 / 2 (+ STT); plan_effects 4,000 / 2,000 / 1 (effects model); distill_style 3,000 / 1,500 / 1 (effects model).
`max_output` is above p90 everywhere but deliberately NOT the dub p99 (24.9k = runaway thinking), which would
reserve ~5× a typical run. The dub system prompt alone is ~4.8k tokens. Frames: (`scene.dub_sample_frame_budget`
+ 2 edge frames) × 258 per clip. Video: 100 / 300 tokens per second (plan figures; quality.py measured ~84 / ~348).

---

## 6. Guards

### 6.1 Layer 1 — reservation at start (Postgres row lock)

**Choice: Postgres `SELECT … FOR UPDATE` on `usage_accounts`**, not Redis Lua.
Why: reservations, settle, refunds, wallet debits and the usage-row accrual must be transactional with each other and with durable rows; contention is per user (≤5 concurrent runs), so a row lock costs nothing; the existing Redis layer is deliberately fail-open (`ratelimit.py`), which is wrong for money; one source of truth survives a Redis flush.

`start_paid_run(session, user, kind, estimate, *, allow_wallet, job_id, reference_id, ip, device) -> AiRun` (`services/api/billing_start.py`, logic in `runs.reserve`):
1. `guard.breaker_open()` → 503 `{"code":"service_paused"}` (Thai detail) unless unlimited.
2. Free plan → `free_tier.check_start(ip, device, user)` → 429 `{"code":"free_tier_limited"}`.
3. Lock account row; roll expired windows; resolve effective plan.
4. `fit = min(headroom(w) for enforced w)`. If `estimate ≤ fit` → hold all on windows. Else overflow = `estimate − max(fit,0)`; wallet need = `ceil(overflow × 35_000 / 1e6)` satang; if `allow_wallet` and available ≥ need → split hold; else 402 `{"code":"limit_reached","window":"weekly","resets_at":ISO,"wallet_can_cover":bool}`.
5. Insert `ai_runs(status="queued")`, bump `reserved_tokens` / `wallet_reserved_satang`, commit **before** enqueue. If enqueue fails → `runs.release(run_id)`.
6. Pass `run_id=` to the arq task kwargs.

Called in each route in `ai_gate.AI_ROUTES` after request validation and **before files are written**; a later exception in the route releases. `ai_gate.py`'s docstring gains: "every AI route must also call `start_paid_run`"; `tests/test_email_flows.py`-style test asserts each AI route calls it.

Settle `runs.settle(run_id, outcome)` (worker `finally`, sync `plan-dub` inline):

| outcome | charged |
|---|---|
| `ok`, `user_cancel`, `user_error` | `min(actual, ceiling)` |
| `limit_stop` (layer 2 fired) | the reservation only (`estimate`) |
| `our_failure` (vendor error, bug, timeout, crash, breaker hard stop) | 0 — refund (usage rows keep the vendor cost) |
| `orphaned` (sweeper; worker died) | 0 |

Distribution: windows take `min(charge, reserved_tokens + max(0, headroom_now))`; remainder from wallet (up to held + balance); anything still left goes onto the windows (overshoot counts, >100 % allowed). Release unused holds. Log `run_settled` with estimate vs actual. `user_error` = new `UserInputError` exception class raised for bad input (missing uploads, bad manifest) in tasks; everything else is `our_failure`.

Sweeper (worker cron, every 10 min): runs `queued`/`running` with `lease_until < now − 10 min` or `created_at < now − job_timeout` → settle `orphaned`.

### 6.2 Layer 2 — per-call guard (gateway hook)

`UsageCtx` gains `run_id`, `job_id`, `ceiling`, and a mutable `RunMeter` (`spent`, `inflight_max`) shared by all calls of the task (covers `asyncio.gather`).

`gateway.acompletion` / `acompletion_stream_thinking`, before the retry loop **and before every retry attempt**:
1. `input_est = extra.pop("billing_input_tokens", None) or litellm.token_counter(model, messages)` — video call sites (`dub_ai`, `speech_select`, `effects_ai`, `effects_style`, `cut_style`) pass `billing_input_tokens` computed by `estimate.video_input_tokens(sec, fps)`, since file parts cannot be counted locally.
2. `max_out = extra.get("max_tokens")`; if absent, gateway sets `max_tokens = settings.llm_max_output_tokens` (default from the profile p99 + margin; Gemini counts thinking inside `maxOutputTokens` — CORE-B verifies once with `scripts/probe_stream_thinking.py` and records the result here).
3. `call_max = tokens_for_llm(model, input_est, 0, max_out)`; if `meter.spent + meter.inflight_max + call_max > ceiling` → set stop flag, raise `RunBudgetExceeded` (not sent).
4. Stop flag check: Redis `noey:run:<run_id>:stop` (fail-open → falls back to in-process meter only).
5. `guard.breaker_hard_stop()` → raise `ServicePaused` (non-admin).
6. `vendor_limits.acquire_gemini(model, input_est + max_out)` (waits).
7. Send; on each attempt end → `metering.record_llm_attempt(...)` awaited (§8); `meter.spent += tokens`.

STT: `run_transcription(before_clip=guard.before_stt_clip, on_clip_billed=metering.record_stt_clip)`; `before_stt_clip(sec)` uses `media_duration(wav) × 51.75` the same way; `vendor_limits.elevenlabs_slot()` wraps `_post_stt`.

Stop propagation: `RunBudgetExceeded`/`ServicePaused` propagate out of the task body → task `except` writes job `error` with `result={"step":"stopped","code":"limit_stop","message":"หยุดแล้ว: ถึงขีดจำกัดการใช้งาน"}` and project `status="error"`; `finally` settles. The server chain (`ingest → transcribe → plan_edit → render`) only enqueues the next step on success, so later steps never run; `_abort_if_cancelled` also returns True when the run is `stopped`, covering steps already queued. `RunBudgetExceeded` is not retryable in `_is_retryable`.

### 6.3 Layer 3 — circuit breaker

- Spend counter: Redis `noey:cb:spend:<UTC date>` `INCRBY` satang on every recorded row (`metering`); on Redis miss, `SUM(cost_thb)` for today cached 60 s.
- `breaker_open()` (start time): `enabled and spend ≥ daily_cap_thb`. `breaker_hard_stop()` (gateway): `spend ≥ cap × hard_stop_ratio`.
- First trip of the day: `SETNX noey:cb:alerted:<date>` → admin audit event `circuit_breaker_tripped` + email to admins via existing mailer. Admin/unlimited users are never blocked.
- Vendor-side caps (Google budget alerts, ElevenLabs prepaid without auto top-up) are owner console actions — listed in `docs/billing-stripe.md` checklist, no code.

---

## 7. Vendor cost + FX

`cost_config` changes (`packages/admin/cost_config.py`):

```python
class ModelPrice(BaseModel):   # USD per 1M
    input: float; output: float
    input_long: float | None = None; output_long: float | None = None; long_threshold: int | None = None
    cached_ratio: float = 0.10
    until: date | None = None          # price valid through this date (inclusive)
    then: "ModelPrice | None" = None   # price after `until`
class SttModelPrice(BaseModel): usd_per_hour: float; keyterms_usd_per_hour: float
class CostConfig: fx_rate (kept = manual fallback), models, stt: dict[str, SttModelPrice], fixed, per_user,
                  vat_included=False, include_internal
```

Defaults: Flash (`gemini-3.7-flash`, `gemini-3.8-flash`) `0.75/3.75 until 2026-12-31 then 1.50/7.50`; `gemini-3.1-pro-preview` `2/12`, long `4/18` above 200k; `scribe_v2` `0.22 + 0.05` keyterms. `vat_included=False` (owner not VAT-registered). A `model_validator(mode="before")` upgrades a stored old document (STT package fields → defaults) so a saved config never 500s.

`vendor_cost.cost_thb_for_llm(model, in, cached, out, at)` / `cost_thb_for_stt(model, sec, keyterms, at)` — config cached 60 s per process.

FX (`packages/billing/fx.py`):
- Daily worker cron `refresh_fx` (00:10 UTC): primary `https://open.er-api.com/v6/latest/USD` (no key), fallback `https://api.frankfurter.app/latest?from=USD&to=THB` (ECB). Sanity band 25–50 else reject. Insert `fx_rates`.
- `current_usd_thb()` = `fx_override` → latest `fx_rates` (≤ 7 days old) → `cost_config.fx_rate` → 34.5. Cached 10 min.
- Rate card never reads FX.

---

## 8. Durable recording (`packages/billing/metering.py`)

- `record_llm_attempt(ctx, model, status, input, cached, output)` and `record_stt_clip(ctx, clip_index, billed_sec, model, keyterms)`: compute `tokens`, `cost_thb`, `fx_rate`, `idem_key=uuid4`; **one transaction**: insert row + `UPDATE ai_runs SET actual_tokens = actual_tokens + :t`. Awaited.
- Retry 3× (0.2 / 0.5 / 1 s). Then `RPUSH noey:usage_outbox <json>`; then as last resort `log.error("usage_record_lost", payload=…)`. Never raises into the AI path.
- Worker cron `drain_usage_outbox` every minute: insert with `ON CONFLICT (idem_key) DO NOTHING`.
- Failed attempts: record with `status="failed"`/`"retry"` when the exception carries provider usage; otherwise `input=0,output=0` and `cost_thb=null` (row still proves the attempt reached the vendor; `_error_phase` in `connection`/`hard_timeout` before send → not recorded).
- `extract_usage_tokens` → returns `(input, output, cached)`; cached from `usage.prompt_tokens_details.cached_tokens` (LiteLLM Gemini mapping).
- `ensure_future(record_usage…)` removed from both gateway paths.

---

## 9. API contracts

### 9.1 `GET /usage/me` (new shape; no token counts)

```json
{
  "plan": "pro", "unlimited": false,
  "limits": [
    {"key": "five_hour", "used_pct": 42.0, "resets_at": "2026-09-22T14:30:00Z", "active": true},
    {"key": "weekly",    "used_pct": 18.5, "resets_at": "2026-09-27T09:00:00Z", "active": true}
  ],
  "blocked": {"key": "five_hour", "resets_at": "…"} ,
  "concurrency": {"max": 2, "running": 1, "queued": 0},
  "wallet": {"balance_satang": 29950, "next_expiry": "2027-09-01T00:00:00Z"},
  "storage": {"used_bytes": 0, "quota_bytes": 10737418240},
  "pending_plan": {"plan": "lite", "at": "…"} ,
  "by_task": [{"task": "cut", "pct": 80.0}],
  "usage_pct": 42.0, "period_start": "…", "reset_at": "…"
}
```
- `used_pct` includes open reservations. `blocked` null when any start is possible. `wallet` null when never purchased.
- `usage_pct`/`period_start`/`reset_at`/`by_task[].pct` are **compat fields for `noey-frontend`** (reads `plan, period_start, usage_pct, unlimited, reset_at, by_task`): `usage_pct` = max over enforced windows, `period_start` = binding window start, `reset_at` = its `resets_at`. `by_task[].total_tokens` is **removed** — the frontend agent must stop reading it.
- `GET /usage/stt` removed (exposes minutes/credits); web/desktop stop calling it.

### 9.2 `POST /usage/estimate`

In: `{"kind": "analyze_video", "mode": "dub_first", "engine": "pro", "precision": "standard", "clips": [{"duration_sec": 34.2, "has_audio": true}], "audio_sec": null}`
Out: `{"fits": "plan" | "wallet" | "none", "pct": {"weekly": 18.2, "five_hour": 45.5}, "wallet_satang": 0, "binding": "five_hour", "resets_at": "…", "unlimited": false}`. Never tokens. Rate-limited per account (60/min).

### 9.3 Start routes

Every `AI_ROUTES` route accepts optional `allow_wallet` (form field or JSON, default false). Errors (JSON `detail`): 402 `limit_reached` (`window`, `resets_at`, `wallet_can_cover`), 429 `free_tier_limited`, 503 `service_paused`, 403 email (unchanged). Response unchanged (`job_id`); job result gains `step:"waiting_slot"` while queued behind the concurrency cap and `step:"stopped", code:"limit_stop"` on a guard stop.

### 9.4 Wallet

| Route | Contract |
|---|---|
| `GET /wallet/me` | `{balance_satang, reserved_satang, lots:[{remaining_satang, expires_at}], history:[{kind, amount_satang, created_at}] (last 30), packs:[10000,30000,50000,100000], methods:["promptpay","card"]}` |
| `POST /wallet/checkout` | in `{pack_satang, method}` → `{url}`. Stripe: Checkout `mode=payment`, `currency=thb`, inline `price_data` (product "Noey extra usage"), `payment_method_types=[method]`, metadata `{noey_topup: pack, user_id}`, success/cancel → `settings.frontend_url + "/settings?tab=usage&topup=…"`. Stripe unset **and** `is_local_deployment(settings.postgres_host)` (the same "real deployment" test `assert_production_secrets` uses) → credits a `mock` lot immediately and returns the success URL. Stripe unset on a real deployment → 503. |
| Webhook | `checkout.session.completed` (`payment_status=paid`) and `checkout.session.async_payment_succeeded` with `mode=payment` + `noey_topup` → `wallet.credit(session_id)` idempotent via unique `stripe_session_id`. The existing `mode != "subscription"` early return in `webhooks.handle_event` branches here instead. |

Consumption rules: only after windows are exhausted (§6.1); refunds on `our_failure` return baht to the lot they came from (or a `refund` lot with that lot's expiry); daily cron `expire_wallet_lots` writes `expire` entries. `ceil` to whole satang per run at settle.

### 9.5 Admin (`/admin/*`, admin session guard, every write audited)

| Route | Purpose |
|---|---|
| `GET /admin/users/{id}` (extended) | windows with real tokens/limits/reserved, wallet, last 50 runs (estimate, actual, charged, outcome, cost_thb) |
| `POST /admin/users/{id}/window-reset` `{window}` | reset `five_hour`/`weekly`/`monthly` (audit `window_reset`). Old `/quota-reset` = all windows (kept as alias) |
| `POST /admin/users/{id}/wallet-adjust` `{amount_satang, note}` | admin credit/debit (audit) |
| `GET /admin/reconciliation?month=YYYY-MM` | per vendor: Σ vendor units, Σ `cost_thb` (attributed vs unattributed rows with null `user_id`/`run_id`), invoice amount, gap %, `warn` when > 5 % |
| `PUT /admin/reconciliation/{month}` `{vendor, amount_thb}` | store invoice |
| `GET /admin/estimate-accuracy?from&to&user_id` | by kind×precision: n, median/p90 of actual/estimate, overshoots (> ceiling), limit stops |
| `GET/PUT /admin/fx` | current rate + source, 30-day history, override |
| `GET/PUT /admin/billing-config` | reference ฿/1M, sell ฿/1M (display), top-up ฿/1M (read-only), rate-card version + table (read-only) |
| `GET/PUT /admin/circuit-breaker` | settings + today's spend + tripped flag |
| `GET /admin/dashboard` (extended) | adds per user/job rate-card tokens + cost_thb, cost per 1M, margin per 1M |

---

## 10. Concurrency + vendor queues

**Per-user concurrency (Postgres):** at task start `runs.acquire_slot(run_id)` locks `usage_accounts`, counts `ai_runs` with `status="running" and lease_until > now`; if `< max` → `status="running"`, `lease_until = now + 10 min` (heartbeat renewed from `_video_progress`/every recorded row). Else the task updates the job row (`step:"waiting_slot"`, "รอคิว — มีงานอื่นกำลังทำอยู่"), re-enqueues itself via `ctx["redis"].enqueue_job(fn, **kwargs, _defer_by=15)` and returns (arq `Retry` is avoided: it consumes `max_tries`). Slot released at settle. Non-AI tasks (`render_*`, `transcode_for_web`, `ingest_video`) take no slot.

**Vendor limits (Redis, cross-process, `vendor_limits.py`):**
- Gemini: Lua sliding-window per model family: `noey:vl:gemini:<family>:rpm` and `:tpm` (ZSET of `(ts, id)` + token sum); acquire loops with jittered sleep (max wait `settings.vendor_wait_max_sec=300`, then raise retryable). Settings `gemini_rpm_flash`, `gemini_tpm_flash`, `gemini_rpm_pro`, `gemini_tpm_pro` (defaults = current AI Studio tier limits, env-set).
- ElevenLabs: lease semaphore ZSET `noey:vl:elevenlabs` (score = lease expiry, 120 s) with `settings.elevenlabs_max_concurrency` (default 5); release in `finally`.
- Redis down → fail open with a warning (same policy as `ratelimit.py`); the per-user reservation still holds.

---

## 11. Plan-change service (`packages/billing/plan_change.py`)

Pure functions over `(session, user, account)`, Stripe-independent, each audited via `admin_auth.audit` when an actor is given:

| Function | Effect |
|---|---|
| `upgrade(user, tier)` | `user.plan = tier` now; windows keep `used` (percent drops immediately); clears `pending_plan` |
| `schedule_downgrade(user, tier, at)` | `pending_plan = tier`, `pending_plan_at = at` (period end) |
| `schedule_cancel(user, at)` | `pending_plan = "free"`, `pending_plan_at = at` |
| `resume(user)` | clears pending |
| `payment_failed(user, at)` | `grace_until = at + 3 d` |
| `payment_recovered(user)` | clears `grace_until` |
| `apply_due(now)` | cron hourly: due `pending_plan` → apply; `grace_until < now` → `free` |

`enterprise` is never changed by these. Webhook wiring later: `_apply` in `service.py` gets one comment marking where `upgrade/schedule_*` replace the direct `user.plan = new_plan` — **not wired now** (plan §6).

---

## 12. Free-tier abuse (`packages/billing/free_tier.py`)

- Sign-up: add `Limit("register:ip_day", 5, 86_400)` next to `REGISTER_IP`; store `signup_ip_hash` = sha256(`secret_key` + ip)[:64] and optional `signup_device_hash` from header `X-Noey-Device` (random id the web keeps in `localStorage`, desktop in `userData`).
- Free AI starts (checked in `start_paid_run` for plan `free` only): Redis SET `noey:free:ip:<hash>` of user ids (TTL 30 d) — max `settings.free_accounts_per_ip=3` distinct free accounts may start AI per IP per 30 d; counter `free_runs:ip` max `settings.free_runs_per_ip_day=10`. Same for device hash. Fail open. Defaults are proposals; env-tunable.

---

## 13. Storage quota

- `limits.PLAN_LIMITS[*].storage_gb` is the source; `settings.plan_storage_limit` delegates (env override kept). Admin/enterprise → 0 (unlimited).
- Enforcement stays in `videos_local.put_file` (already there); also add the check to `POST /transfer/*` and `POST /videos` (server upload) where bytes land permanently. Over quota after downgrade → uploads refused, nothing deleted.
- `/usage/me.storage` mirrors `GET /videos/storage`.

---

## 14. Client changes

### Web (`web/src`)
| File | Change |
|---|---|
| `lib/api.ts` | New `Usage` type (§9.1), `estimateUsage`, `getWallet`, `startTopup`; drop `getSttUsage` |
| `lib/usageLimits.ts` (new) + test | `LIMIT_LABELS` (`5-hour limit`/`Weekly limit`/`Monthly limit`), `formatResetTime(iso)` via `Intl.DateTimeFormat(undefined, …)` (viewer tz), `formatBaht(satang)` → `฿299.50`, `limitBlockedMessage` ("ถึงขีดจำกัดแล้ว · Resets 2:30 PM") |
| `components/settings/UsageMeters.tsx` (new) | one bar per `limits[]`, reset time, concurrency line |
| `components/settings/WalletCard.tsx` (new) | balance "เหลือ ฿xx.xx", packs ฿100/300/500/1,000, PromptPay first, history |
| `pages/SettingsPage.tsx` | UsageTab uses the two above; handles `?topup=` return; no token numbers |
| `components/settings/TaskBreakdown.tsx` | pct only |
| `components/wizard/UsageEstimate.tsx` (new) | debounced `POST /usage/estimate` when files/mode/precision change; "ใช้ประมาณ 18% ของ Weekly limit"; blocked state + "ใช้ยอดเงินคงเหลือ" toggle |
| `components/wizard/WizardStepFiles.tsx`, `WizardStepReview.tsx`, `pages/WizardPage.tsx`, `lib/wizardState.ts` | mount estimate; disable start when `fits=="none"`; carry `allowWallet` |
| `lib/videosLocalApi.ts`, `lib/useProjectPipeline.ts` | send `allow_wallet`; map 402/429/503 codes |
| `lib/apiError.ts` | parse `detail.code` → Thai messages with reset time |
| `pages/JobProgressPage.tsx` | `waiting_slot` and `stopped/limit_stop` states |
| `platform/noey-web.ts` / `lib/authedFetch.ts` | send `X-Noey-Device` |

### Desktop (`desktop/app/src/renderer/src`, files present on this machine)
`lib/api.ts`, `lib/usageLimits.ts` (new copy), `pages/SettingsPage.tsx` (meters + wallet; checkout opens in the external browser via existing `setWindowOpenHandler`), `lib/videosLocalApi.ts` + `lib/useProjectPipeline.ts` (`allow_wallet`, error codes), `main/apiProxy.ts` (forward `X-Noey-Device`). **Missing here → PARITY.md rows:** wizard (`WizardPage.tsx`, `components/wizard/*`, `wizardState.ts` → estimate UI), `JobProgressPage.tsx` (waiting/stopped states), `lib/apiError.ts`, `components/settings/*`.

### Admin (`admin/src`)
`lib/types.ts` (runs, windows, wallet, reconciliation, accuracy, fx, breaker types; STT per-hour), `lib/money.ts` (+test: cost from `cost_thb` facts, cost/1M and margin/1M, STT per hour, no VAT default), `lib/plans.ts` (limits table), `lib/server/api.ts` + `app/actions.ts` (new endpoints), `components/UserDrawer.tsx` (windows, runs, reset buttons, wallet adjust), `components/CostsTab.tsx` (vendor prices with dated schedule, FX + override, breaker), `components/OverviewTab.tsx` (cost/margin per 1M, reconciliation, accuracy), `components/PricingTab.tsx` (reference/sell editable, rate card read-only).

---

## 15. Deviations log

| Date | What | Why |
|---|---|---|
| 2026-09-22 | Per-run `ai_runs` table added (plan said `job_id` on rows) | `core.jobs.id` is reused per project (`vlocal_<uid[:8]>`); a job id cannot identify one run. `job_id` is still stored |
| 2026-09-22 | Paid plans enforce Weekly (+5h) only; monthly tracked but enforced for Free only | Plan §2 "user-visible limits"; weekly × 4.33 already bounds the month |
| 2026-09-22 | Breaker blocks new starts at the cap, in-flight calls only at cap × 1.25 | Plan says "refuse new jobs"; a hard stop protects against runaway in-flight work without killing every started job at the first baht over |
| 2026-09-22 (CORE-A) | `packages/billing/limits.py` written by CORE-A (the pure `PLAN_LIMITS` table + `window_limit` / `is_unlimited`, exactly §4) | `POST /usage/estimate` needs the limits to turn an estimate into percentages. The settings cleanup and the window state stay CORE-B's |
| 2026-09-22 (CORE-A) | `/usage/estimate` reads window usage through a stub `_window_use()` in `routers/usage.py` that returns nothing; `fits` is `"plan"` / `"none"` only | No `usage_accounts` yet: `pct` (this run's share of each limit) is exact, `fits` says whether it fits an EMPTY window. CORE-B replaces `_window_use` with `runs` state (used + reserved, `resets_at`) and adds `"wallet"`; `wallet_satang` already reports what the balance would pay |
| 2026-09-22 (CORE-A) | `extract_usage_tokens` still returns `(input, output)`; cached tokens come from new `extract_cached_tokens` / `extract_stream_cached_from_chunks` | A triple return would have broken every existing caller and test for no gain |
| 2026-09-22 (CORE-A) | `hard_timeout` attempts ARE recorded (zero tokens, `status` retry/failed); only `connection` errors are skipped | `asyncio.wait_for` timing out means the request was sent and may be billed; only a connect/DNS failure provably never reached the vendor |
| 2026-09-22 (CORE-A) | `record_usage` / `record_stt_usage` kept as thin wrappers over `metering` (not removed) | Callers outside the gateway keep working; CORE-B may delete them with `check_limit` |
| 2026-09-22 (CORE-A) | No data backfill of `tokens` / `cost_thb` on legacy rows | The admin money module prices legacy rows (`uncosted_*` facts) from the draft price table at today's schedule and the live FX; legacy STT seconds are priced WITH the keyterms surcharge (the worker always sent keyterms) |
| 2026-09-22 (CORE-A) | Stored legacy `cost_config` documents are upgraded on read: STT package → per-hour defaults, the three stale default model prices → correct defaults, `vat_included` → false | Plan §5 / owner: stale defaults were never real prices, owner is not VAT-registered. Prices the owner had edited away from a stale default are kept |
| 2026-09-22 (CORE-A) | Dashboard payload: `stt_rates` → `stt_defaults` (per-hour prices), plus `rate_card` (`rate_card.describe()`) and `fx` (`{usd_thb, source}`) | STT is pay-as-you-go now; the admin needs the sell price for margin per 1M and the live FX to price legacy rows |
| 2026-09-22 (CORE-A) | Reconciliation months are UTC calendar months; admin labels name the work ("AI ตัดต่อ" / "ถอดเสียง"), not the vendor | Vendors invoice by calendar month; no vendor names in UI strings |
| 2026-09-22 (CORE-B) | Reservation happens BEFORE any upload is stored on analyze-frames / analyze-video / transcribe-audio / reedit / plan-dub / voiceover (priced on server-held `local_meta.clips`, a manifest only ever raising it); AFTER the upload on plan-effects, `POST /effect-styles`(+regenerate) and `POST /videos` | Those three have no server-held duration: the footage is the upload itself, so it is measured (ffprobe) first. A refused start deletes the server upload (`POST /videos`) or leaves only scratch that the next run overwrites |
| 2026-09-22 (CORE-B) | The gateway does NOT force `max_tokens` onto requests; the guard budgets a call's output at its own `max_tokens` if set, else the run profile's `max_output`. `probe_stream_thinking.py` not run (no live vendor calls in this phase) | Truncating a thinking model mid-JSON fails the run outright; the ceiling check already bounds the overshoot to one call and settle caps the charge. Budget = estimator figure, so the guard never stops a run the estimate allowed |
| 2026-09-22 (CORE-B) | No `billing_input_tokens` at the call sites: the guard prices text locally (chars ÷ 3), each image part at 258, and any video part at the run's own `video_input_tokens(media_sec, precision)` | The run already knows its footage; one rule in `guard.input_budget` instead of five call-site edits. `billing_input_tokens=` still works for a caller that knows better |
| 2026-09-22 (CORE-B) | dub_ai's bounds-correction retry is an OPTIONAL call (`guard.optional_call`): past the ceiling it is skipped and the first usable answer kept, the run is not stopped | Otherwise every overrun correction would turn a usable result into a `limit_stop` |
| 2026-09-22 (CORE-B) | Circuit-breaker spend = `SUM(cost_thb)` of today's (UTC) usage rows, cached 30 s per process — no Redis `INCRBY` counter | One source of truth that survives a Redis flush; the 30 s cache is the only lag. First-trip alert is still deduped via Redis `SETNX` (in-process fallback) |
| 2026-09-22 (CORE-B) | `limit_stop` charges `min(actual, estimate)`; the wallet is debited only at settle and only for a run that held wallet money; `our_failure` settles at 0, so "refund in baht" = the hold is released (`wallet.refund` exists for an already-settled debit) | Plan: "charge at most the reservation". Deferring every debit to settle makes refunds a no-op instead of a reversal; a window-only run's overshoot goes on the windows (>100 %), never silently onto a balance the user did not offer |
| 2026-09-22 (CORE-B) | `users.usage_reset_at` kept (not dropped); `quota-reset` now clears all three windows and stamps it | The admin app still reads the field; drop it once the admin UI moves to `windows` |
| 2026-09-22 (CORE-B) | `POST /videos/transfer/*` is not storage-checked | It is a single-use courier: files are deleted the moment the web pulls them, and they then land via `PUT /videos/{uid}/files/*`, which is checked |
| 2026-09-22 (CORE-B) | Free-tier identity hashes are salted with `jwt_secret` | There is no separate `secret_key` setting; it is the one server secret every deployment already has |
| 2026-09-22 (CORE-B) | `plan_change` IS wired into the Stripe sync (`service._apply` → `plan_change.mirror_subscription`) | The CORE-B task said "wired where webhooks already dispatch". Stripe says what the customer has; plan_change decides when: upgrade now, lower tier scheduled for `current_period_end`, `cancel_at_period_end` → `pending_plan=free`, `past_due` → 3-day grace then Free even while Stripe still says past_due |
| 2026-09-22 (CORE-B) | `/usage/me` also returns `grace_until`, a `label` per limit, and `by_feature: []` | `by_feature` is iterated by the current web/desktop settings screens; always empty so they render "no requests" instead of crashing until the client phase moves them to `limits` |
| 2026-09-22 (CORE-B) | A multi-task server chain is ONE run: `ingest_video` (and `transcribe_video`, called inline) hand `run_id` on; only the terminal step (`plan_edit` / `analyze_dub_first`) settles; a handing-over step holds the slot 30 min | Settling per step would charge/refund halves of one job. `_abort_if_cancelled` is unchanged: instead every step asks `acquire_slot`, which answers `gone` for a closed run |
| 2026-09-22 (CORE-B) | `check_limit` → `check_ai_access` (verified-email gate only); `UsageLimitExceeded`, `_period_start`, `sum_tokens_since`, `MODEL_PRICES`, `estimate_cost_usd`, `GET /usage/stt`, `settings.plan_*_monthly_tokens` removed | Limits are checked once at start (reservation) + per call against the run ceiling; nothing counts raw vendor tokens per UTC day any more |
| 2026-09-22 (CORE-B) | `POST /videos` dub_first reserves as `analyze_frames` (the server chain's `analyze_dub_first` reads sampled frames); talking_head as `server_pipeline` | Matches what the server chain actually sends |
| 2026-09-22 (ADMIN-UI) | `GET /admin/dashboard` users gain `topup_satang` / `topups` (paid lots — source `stripe`/`mock` — bought in the period, gross) and `wallet_spent_satang` (run debits net of their refunds) — `packages/admin/metrics.py:_wallet_by_user`, test in `test_admin_billing.py` | The admin must show top-up revenue and CORE-B exposed only the balance cache. Admin credits (`adjust`) and refund lots are not revenue; payment fees are not deducted (not tracked per lot) — the admin labels the figure "before the payment fee" |
| 2026-09-22 (ADMIN-UI) | Admin money: revenue = subscription + top-ups bought in the period (cash basis); profit, break-even and the monthly projection use it. Margin per 1M uses `billing_config.sell_thb_per_1m` (display value), falling back to the rate card's | The owner edits the display sell price in the admin; users are still charged the code constant, which the Pricing tab shows read-only |
| 2026-09-22 (EDITOR-UI) | The editor names the windows in THAI (`โควตารายเดือน` / `โควตารายสัปดาห์` / `โควตารอบ 5 ชั่วโมง`, `lib/usageLimits.ts` `LIMIT_LABELS`), not the English `label` the API sends | The owner's editor design (docs/design/editor-limits.md, 2026-09-22) and plan §5 supersede the earlier "English limit labels" note; the English labels stay the marketing site's pricing copy. One constant to change if the owner reverses it |
| 2026-09-22 (EDITOR-UI) | "Continue with my balance" is consent for ONE start: stored on the local project (`LocalProject.allowWallet`), sent as `allow_wallet`, cleared once a start route accepts. A refused run keeps the refusal on `LocalProject.billingStop` for the error card | The pipeline, not the screen, makes the start call (after import, minutes later); the project row is the only thing both share. Per-run consent keeps a later plan-dub from silently spending the balance |
| 2026-09-22 (EDITOR-UI) | Web top-up opens the checkout in a new tab (opened on the click, before the request) and refreshes the balance when the tab regains focus; the mock credit (return URL with `topup=success`) is detected and refreshed in place. Desktop opens it in the system browser | The checkout's return URL is the marketing site's `/settings`, which the editor cannot own |
| 2026-09-22 (EDITOR-UI) | `separate` upload mode (one project per clip) is estimated as ONE run over all clips | N runs differ from one only by the per-run prompt overhead; one request keeps the 60/min estimate limit out of reach |
| 2026-09-22 (EDITOR-UI) | Not built this phase: the plans list + change-plan / consent modal (editor-limits §5–6), the near-limit banner (§2), the footage/storage one-line notices (§4) | Out of this task's scope (it named meters, wallet, wizard estimate, job states, recut estimate). The payment-failed line (§4) IS in the usage card |
| 2026-09-22 (REVIEW) | **Supersedes CORE-B's "reserve before any upload is stored" and "priced on `local_meta.clips`, a manifest only raising it".** Every start is priced on what the SERVER measured on the files it received (`ffmpeg_bin.measure_media`: container duration → longest stream → full decode). analyze-video / reedit proxies, the reedit preview, the plan-effects cut proxy + reference and the transcribe-audio WAVs land in a private `.incoming-*` staging folder, are measured, THEN the run is reserved; they move into place only after it is. analyze-frames is priced on the number of frames uploaded (`estimate_run(frame_count=)`). A file that cannot be measured is refused (422), never priced as 0 s; a proxy whose short side is over 482 px is refused (client proxies are 480 tall) | Review finding: a client could state 1 s for a 20-minute proxy and be charged a fraction of the vendor cost (charge ≤ ceiling). Staging keeps "a refused start stores nothing" |
| 2026-09-22 (REVIEW) | **Supersedes CORE-B's "no `billing_input_tokens` at the call sites".** Video call sites pass `billing_video_sec` (Σ seconds of EVERY video file the request attaches, measured on disk: source proxies + reedit preview; cut + video reference; style reference) and `billing_video_precision`; the guard prices them with `estimate.video_input_tokens`. The run-level `media_input_tokens` stays only as the fallback for a call that sends video without saying how much | The run total added once per call missed the reedit preview and the effects reference entirely |
| 2026-09-22 (REVIEW) | **Supersedes CORE-B's "the gateway does NOT force `max_tokens`".** For a request with no `max_tokens` of its own the guard returns the output the run can still afford — `floor((ceiling − spent − in_flight − input×rate_in) / rate_out)` — and the gateway sends it; it is ≥ the profile's `max_output` whenever the call was admitted. An answer cut off there (`finish_reason == "length"`) is a `limit_stop` (`guard.output_truncated`; an optional call is skipped instead). Parallel calls are each capped at what was left when THEY were admitted | Nothing bounded output, so one admitted call could write ~57k tokens past its budget while the charge stays capped at the ceiling. Runs whose thinking runs away (the measured dub p99, 24.9k output) now stop as `limit_stop` instead of finishing at our cost — re-measure on production |
| 2026-09-22 (REVIEW) | `UserInputError` moved to `packages/core/errors.py` (the worker re-exports it). A content-filter refusal of the user's footage (`dub_ai`) and a speech-to-text 400/413/415/422 on a file (`ElevenLabsInputRejected`) raise it → `user_error` (charged what was used). Refund cap: a user's first `settings.billing_free_refunds_per_day` (3) `our_failure` runs of a UTC day that burned vendor tokens are refunded; later ones are charged `min(actual, ceiling)` (status `settled`, outcome still `our_failure`). `GET /admin/users/{id}` adds `failed_runs_30d` | Vendor-billed failures caused by the user's input were refunded in full and repeatable until the global breaker paused everyone |
| 2026-09-22 (REVIEW) | Output model resolution: one resolver per call site (`quality.reedit_model / speech_model / effects_model / cut_style_model`, `llm.config.vision_model / text_model`), used by the call site AND `estimate.model_for`. `MODE_PROFILES`: analyze_frames → vision, reedit → reedit, plan_dub / voiceover → text. Distill-style reserves at the style kind's model | analyze_frames was priced at the Flash engine while the frame path calls the Pro vision model: the guard stopped every such run before its first request |
| 2026-09-22 (REVIEW) | Gateway: an attempt cancelled mid-flight (`asyncio.CancelledError` — worker SIGTERM, arq job timeout) is recorded (`status="cancelled"`, streamed usage or the admitted input estimate) before re-raising; a timed-out attempt with no reported usage charges its input estimate to the run meter so retries count against the ceiling | Cancelled attempts were billed by the vendor but never recorded; timed-out retries were each admitted at the full budget |
| 2026-09-22 (REVIEW) | STT per-file guard: an unmeasurable WAV is priced from its size ÷ 8,000 B/s (an upper bound), never 0 s | Fail-open |
| 2026-09-22 (REVIEW) | Mock top-up needs `WALLET_MOCK_TOPUP=1` AND a loopback database host (`is_loopback_host`); `assert_production_secrets` refuses the flag on a real deployment. The local `.env` sets it | `is_local_deployment` also matched docker-compose names (`postgres`/`db`), so a compose deployment without Stripe keys minted free balance |
| 2026-09-22 (REVIEW) | Stripe `charge.refunded` / `charge.dispute.created` take a top-up back: `wallet_lots.stripe_payment_intent` (migration `ce0c8c1ea951`, autogenerated) finds the lot (older lots via one Stripe lookup, then stored); `wallet.reverse_lot` debits the unspent part with a `reversal` ledger row (cumulative, so partial refunds work); a spent part is an audit event `topup_reversal_shortfall`. `checkout.session.async_payment_failed` is acknowledged. Admin top-up revenue is net of reversals | Refunded or charged-back top-ups stayed spendable |
| 2026-09-22 (REVIEW) | Free tier: `check_start` only READS the IP/device day counter; `count_run` increments it after `runs.reserve` succeeded | A 402 refusal spent the daily free runs every account behind the same NAT shares |
| 2026-09-22 (REVIEW) | A queued run renews `lease_until` on every slot wait; `sweep_orphans` orphans a queued run only when it is older than `QUEUED_MAX_AGE` AND its lease lapsed. A task that arrives for a closed run whose job is still `waiting_slot` ends the job and its project (or style) in `error` ("งานรอคิวนานเกินไป กรุณาเริ่มใหม่") | Swept waiting runs left the job on "รอคิว" forever and the project stuck in processing |
| 2026-09-22 (REVIEW) | `reference_max_sec` (1,200 s) now caps every style reference (cut AND effects kinds) and the plan-effects reference | Every second is billed video input; only cut styles had a cap |

---

## 16. Test plan (pytest `backend/tests/`, vitest web/admin/desktop)

| File | Covers |
|---|---|
| `test_rate_card.py` | family matching, unknown→pro, cached 10 %, >200k tier, ceil, STT 51.75, version immutability |
| `test_estimate.py` | per kind/precision formula, server recompute ignores client numbers, profiles present for every AI route |
| `test_vendor_cost.py`, `test_fx.py` | dated schedule switch at 2027-01-01, long tier, keyterms cost, fetch primary→fallback→last→default, sanity band, override wins (httpx mocked) |
| `test_metering.py` | row + `actual_tokens` in one txn, retry then outbox, drain idempotent, failed attempt rows, cached tokens extracted |
| `test_gateway_billing.py` | guard blocks before send, one-call overshoot max, retries re-checked, stop flag, breaker hard stop, limiter called, no `ensure_future` |
| `test_windows.py` | rolling start on first use, expiry, resets_at, reservations count, overshoot >100 % |
| `test_runs.py` | reserve/settle/refund/limit_stop/orphaned charge table, wallet split, **race**: N concurrent reserves on one user never exceed headroom (real Postgres, `asyncio.gather`) |
| `test_concurrency_slots.py` | cap per plan, re-enqueue with defer, lease expiry frees slot |
| `test_vendor_limits.py` | Lua RPM/TPM + semaphore with fakeredis/real Redis, fail-open |
| `test_wallet.py` | credit idempotency, FIFO by expiry, refund to lot, expiry cron, satang ceil |
| `test_topup.py` | Stripe session params (PromptPay first), webhook paid/async, mock path only on a local deployment |
| `test_plan_change.py` | upgrade immediate, downgrade/cancel at period end, 3-day grace → free, enterprise untouched |
| `test_free_tier.py` | per-IP/device caps, fail-open |
| `test_storage_quota.py` | new GB values, admin unlimited, transfer/upload paths |
| `test_usage_api.py` | `/usage/me` shape: no token keys anywhere (recursive key scan), compat fields, estimate endpoint, auth |
| `test_admin_billing.py` | window reset audited, reconciliation 5 % warn, accuracy aggregates, non-admin 401/403 on every new route |
| `test_worker_billing.py` | per-clip STT rows, settle in `finally` per task, `limit_stop` job result, chain not continued |
| web `lib/usageLimits.test.ts`, `components/wizard/UsageEstimate` logic test, `noLeaks.test.ts` extended (no "token" in UI strings); admin `money.test.ts`; desktop `lib/usageLimits.test.ts` |

Keep green: existing suite (5 known failures: `test_dub_render.py` ×3, `test_llm_config.py` ×2). Update tests that pin the old daily quota (`grep -rl "plan_token_limit\|_period_start\|usage_pct" backend/tests`).

---

## 17. Task split (sequential)

### CORE-A — rate card, cost recording, estimator, FX
1. `rate_card.py` + tests.
2. `cost_config.py` new shape/defaults/upgrade validator; `vendor_cost.py`; `fx.py` + `fx_rates` model + `refresh_fx` cron + `/admin/fx`; tests.
3. Models: §3.1, §3.2 columns, `ai_runs` (full table, CORE-B fills behaviour), `fx_rates`, `vendor_invoices`; **one** autogenerated migration.
4. `metering.py` (durable record + outbox + drain cron); `extract_usage_tokens` returns cached; gateway both paths record every attempt, awaited; remove `ensure_future`.
5. STT per clip: `run_transcription` callbacks; worker `_record_stt` replaced; `keyterms` flag.
6. `UsageCtx.run_id/job_id` plumbing (fields only; null until CORE-B creates runs).
7. `estimate.py` + `scripts/usage_profile.py` calibration + `POST /usage/estimate`.
8. Admin read side: dashboard/user facts gain `tokens`, `cost_thb`; `money.ts` cost/1M + margin; CostsTab vendor prices + FX; reconciliation endpoints + view.
9. Update this doc's §5 with measured profiles.

### CORE-B — limits, reservation, guards, queues, breaker, wallet, plan change, free tier, storage, APIs
1. `limits.py`; settings cleanup (`plan_token_limit` out, storage GB fixed); `usage_accounts`, wallet tables, `users.signup_*`; one autogenerated migration.
2. `runs.py` (window math, reserve/settle/release/sweeper) + `start_paid_run` wired into every `AI_ROUTES` route (+ sync `plan-dub`); `run_id` through `_enqueue` and every AI task; `UserInputError`.
3. `guard.py` in gateway + STT; stop flag; `_abort_if_cancelled` honours stopped runs; `llm_max_output_tokens`; `billing_input_tokens` at video call sites.
4. Concurrency slots in worker; `vendor_limits.py`.
5. Circuit breaker + alert + admin route.
6. `wallet.py`, `topup.py`, `routers/wallet.py`, webhook branch, expiry cron.
7. `plan_change.py` + `apply_due` cron (not wired to Stripe).
8. `free_tier.py` + register limit + device header.
9. Storage quota paths.
10. `/usage/me` new shape; remove `/usage/stt`; admin endpoints (window reset, wallet adjust, accuracy, billing-config, breaker); remove `check_limit`/`_period_start` readers (`admin/metrics.py`).
11. Then the client phase (web → desktop → admin UI) and PARITY.md rows for the missing desktop files.

---

## 18. CORE-A status (2026-09-22) — what CORE-B builds on

Done: `rate_card.py` (v1), `limits.py` (table only), `estimate.py` (e1) + `POST /usage/estimate`, `vendor_cost.py`,
`fx.py` + `fx_rates` + worker cron `refresh_fx_rate` (00:10 UTC) + `GET/PUT /admin/fx` + `POST /admin/fx/refresh`,
`metering.py` (awaited insert ×3 retries → Redis outbox `noey:usage_outbox` → `usage_record_lost` log; worker cron
`drain_usage_outbox` every minute), gateway records every attempt, STT per clip via
`run_transcription(on_clip_billed=)` → worker `_record_stt_clip`, `UsageCtx.run_id/job_id` (worker passes `job_id`;
`run_id` is null until CORE-B creates runs), `cost_config.py` new shape/defaults, `reconciliation.py` +
`GET /admin/reconciliation` + `PUT /admin/reconciliation/{month}`, admin facts (`tokens`, `cost_thb`, `uncosted_*`,
`failed_calls`), admin app (money.ts recorded cost / cost per 1M / margin per 1M, per-hour STT, FX card,
reconciliation card). Migration `c4b56f3a5120` (autogenerated; tenant-table drift removed): usage-row columns,
`ai_runs` (full table, no behaviour), `fx_rates`, `vendor_invoices`.

Hooks left for CORE-B:
- `metering.record_llm_attempt` / `record_stt_clip` return the rate-card tokens charged → `meter.spent += …`.
  `_insert` already does `ai_runs.actual_tokens += tokens` in the same transaction when `ctx.run_id` is set.
- `_set_video_usage_ctx(..., job_id=, run_id=)` in `services/worker/tasks.py` — pass `run_id` from task kwargs.
- `estimate.video_input_tokens(sec, precision)` is the `billing_input_tokens` helper for video call sites.
  The guard's `max_tokens` must equal the profile's `max_output` or the guard will stop runs the estimate allowed.
- `estimate.clip_seconds_from_meta(local_meta)` gives the server-known durations for start-route recompute.
- `routers/usage.py:_window_use` is the stub to replace; `/usage/me` and `/usage/stt` are untouched (still the old
  daily quota) — CORE-B reshapes them.
- The old `check_limit` still runs before every call (it counts raw vendor tokens per UTC day) until CORE-B removes it.

---

## 19. CORE-B status (2026-09-22) — contracts for the client phase

Built: `usage_accounts` / `wallet_lots` / `wallet_ledger` / `users.signup_*` (migration `798eb04b7fef`,
autogenerated, drift removed, no backfill); `accounts.py` (the row lock), `runs.py` (window math, reserve,
settle, release, slots, sweeper, admin reset), `guard.py` (per-call ceiling + circuit breaker + alert),
`vendor_limits.py` (Gemini RPM/TPM Lua window, ElevenLabs lease semaphore, fail-open), `wallet.py`,
`topup.py`, `plan_change.py`, `free_tier.py`; `services/api/billing_start.py` wired into every
`AI_ROUTES` route; worker `billed_task` on every AI task + crons `sweep_runs` (10 min),
`apply_plan_changes` (hourly), `expire_wallet_lots` (00:20 UTC); storage quotas 1/3/5/10/30/60/100 GB
(admin unlimited, `POST /videos` checked); `GET /usage/me` (new), `POST /usage/estimate` (real window
state + `wallet`), `/wallet/*`, admin endpoints below.

All times are UTC ISO-8601 with `Z`; the browser formats them in the viewer's timezone. Money is satang
(integer; ฿ = satang / 100). No user-facing body carries a token count.

### `GET /usage/me`
```json
{
  "plan": "pro", "unlimited": false,
  "limits": [
    {"key": "weekly", "label": "Weekly limit", "used_pct": 18.5, "resets_at": "2026-09-29T09:00:00Z", "active": true},
    {"key": "five_hour", "label": "5-hour limit", "used_pct": 42.0, "resets_at": "2026-09-22T14:30:00Z", "active": true}
  ],
  "blocked": null,
  "concurrency": {"max": 2, "running": 1, "queued": 0},
  "wallet": {"balance_satang": 29950, "next_expiry": "2027-09-22T12:00:00Z"},
  "storage": {"used_bytes": 123456, "quota_bytes": 10737418240},
  "pending_plan": {"plan": "lite", "at": "2026-10-10T00:00:00Z"},
  "grace_until": null,
  "by_task": [{"task": "cut", "pct": 80.0}, {"task": "effects", "pct": 20.0}, {"task": "style", "pct": 0.0}, {"task": "other", "pct": 0.0}],
  "usage_pct": 42.0, "period_start": "2026-09-22T09:30:00Z", "reset_at": "2026-09-22T14:30:00Z",
  "by_feature": []
}
```
`limits[]` = the plan's ENFORCED windows (Free: monthly; Lite/Starter: weekly; Pro+: weekly + five_hour),
`used_pct` includes open reservations and may exceed 100. An inactive window has `active:false`,
`resets_at:null` ("starts at next use"). `blocked` = `{"key","resets_at"}` when the fullest window has no
headroom (a start then needs `allow_wallet`), else null. `wallet` null until the first purchase/credit.
Unlimited (admin / enterprise): `limits: []`, `usage_pct: null`, `storage.quota_bytes: 0`.

### `POST /usage/estimate`
In: `{"kind"?: str, "mode"?: "dub_first"|"highlight"|"talking_head"|"speech_scenes"|"speech_highlights",
"engine"?: "lite"|"pro", "precision"?: "standard"|"high", "clips": [{"duration_sec": 34.2, "has_audio": true}],
"audio_sec"?: float}` →
`{"fits": "plan"|"wallet"|"none", "pct": {"weekly": 18.2, "five_hour": 45.5}, "wallet_satang": 0,
"binding": "five_hour"|null, "resets_at": ISO|null, "unlimited": false}`. `pct` = this run's share of each
limit; `fits` counts what is already used + reserved; `wallet` = fits only with "continue with my balance"
(it would pay `wallet_satang`). 422 unknown mode, 429 over 60/min.

### Start routes (every `AI_ROUTES` entry)
New optional field `allow_wallet` (multipart form field `"true"`/`"false"`; JSON `allow_wallet` on
`POST /videos/{uid}/plan-dub`). Refusals (JSON `detail` object):
- 402 `{"code":"limit_reached","window":"weekly","label":"Weekly limit","resets_at":ISO|null,"wallet_can_cover":bool,"wallet_satang":int,"message":"ใช้งานครบ Weekly limit แล้ว[ — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้]"}`
- 429 `{"code":"free_tier_limited","message":…}` · 503 `{"code":"service_paused","message":…}` · 507 storage full (string detail, `POST /videos`)
- `POST /videos/{uid}/plan-dub` only: 402 `{"code":"limit_stop","message":"หยุดแล้ว: ถึงขีดจำกัดการใช้งานของงานนี้"}` when the guard stops the synchronous call.
Job rows (`GET /jobs/{id}` → `result`): `{"step":"waiting_slot","message":"รอคิว — มีงานอื่นกำลังทำอยู่"}` while
queued behind the concurrency cap (status `queued`); `{"step":"stopped","code":"limit_stop"|"service_paused","message":…}`
(status `error`) when a run is stopped. Header `X-Noey-Device` (random id per install) is read by
`/auth/register` and every start route (free-tier limits).

### Wallet
- `GET /wallet/me` → `{"balance_satang":int,"reserved_satang":int,"lots":[{"remaining_satang":int,"expires_at":ISO}],
  "history":[{"kind":"purchase"|"debit"|"refund"|"expire"|"adjust","amount_satang":signed int,"created_at":ISO}],
  "packs":[10000,30000,50000,100000],"methods":["promptpay","card"]}`
- `POST /wallet/checkout` `{"pack_satang":10000|30000|50000|100000,"method":"promptpay"|"card"}` → `{"url":str}`.
  Stripe: hosted Checkout; returns to `FRONTEND_URL/settings?tab=usage&topup=success&session_id=…` (or
  `topup=cancel`). No Stripe on a LOCAL deployment: credited at once, `url` = the success URL. No Stripe on a real
  deployment: 503. 422 unknown pack/method.

### Admin (all behind the admin session; writes audited)
- `GET /admin/users/{id}` adds `limits` (`effective_plan, unlimited, windows:[{key,limit_tokens,used_tokens,reserved_tokens,used_pct,active,resets_at}], quota_window, quota_limit_tokens, quota_used_tokens, quota_used_pct, wallet_balance_satang, pending_plan, grace_until`), `wallet` (the `/wallet/me` body), `runs` (last 50: `id, kind, mode, engine, precision, reference_id, status, outcome, unlimited, media_sec, estimate_tokens, ceiling_tokens, actual_tokens, charged_tokens, charged_wallet_satang, cost_thb, created_at, settled_at`), `estimate_accuracy` (90 days).
- `GET /admin/dashboard`: each user also carries the `limits` fields above (flattened); plus `billing_config`, `circuit_breaker`, `estimate_accuracy` for the period.
- `POST /admin/users/{id}/window-reset` `{"window":"five_hour"|"weekly"|"monthly"}` → the user's `limits` facts (audit `window_reset`). `POST …/quota-reset` = all three (audit `quota_reset`).
- `POST /admin/users/{id}/wallet-adjust` `{"amount_satang": ±int, "note": str(1–200)}` → `/wallet/me` body (audit `wallet_adjust`).
- `GET /admin/estimate-accuracy?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=` → `{from,to,user_id,overall:{runs,median_ratio,p90_ratio,over_ceiling,limit_stops,estimate_tokens,actual_tokens},by_kind:[{kind,precision,…same}],estimator_versions:[…]}`.
- `GET|PUT /admin/billing-config` — PUT `{"reference_thb_per_1m":50,"sell_thb_per_1m":250}` (display/margin only) → adds read-only `topup_thb_per_1m`, `charged_sell_thb_per_1m`, `rate_card`.
- `GET|PUT /admin/circuit-breaker` — PUT `{"enabled":bool,"daily_cap_thb":≥0,"hard_stop_ratio":1–10,"alert_email":str|null}` → `{…settings, "day":"YYYY-MM-DD","spend_today_thb":float,"tripped":bool,"hard_stopped":bool}`.

Hooks left for the client phase: web/desktop `lib/api.ts` still type `/usage/me` with the old token fields and
`getSttUsage` (now 404) — move them to the shapes above; send `allow_wallet` and `X-Noey-Device`; map the
402/429/503 codes and the `waiting_slot` / `stopped` job steps (§14).

---

## 20. Admin UI status (2026-09-22)

Built in `admin/src`: `lib/types.ts` (limit windows, runs, wallet, accuracy, billing config, breaker),
`lib/billing.ts` (English window labels, argument checks for window reset / wallet adjust / breaker / per-1M,
viewer-timezone `formatResetAt`, accuracy verdict), `lib/plans.ts` (`PLAN_LIMITS` mirror of
`packages/billing/limits.py`), `lib/money.ts` (top-up revenue, balances, `runRatio`, billing-config sell/reference,
CSV `quota_window`/`quota_pct`/`topup_thb`/`wallet_balance_thb`), `app/actions.ts` (`resetWindowAction`,
`walletAdjustAction`, `saveBillingConfigAction`, `get/saveCircuitBreakerAction`). Components: `UserBilling.tsx`
(drawer: windows with real tokens + per-window and all-window reset, wallet balance/history/adjust, last runs with
estimate vs actual + the user's 90-day accuracy), `BreakerCard.tsx` (Costs tab), `BillingConfigCard.tsx` (Pricing
tab: reference/sell editable, charged ฿250 and top-up ฿350 read-only, rate card, plan limits, top-up totals),
Overview (cost/margin per 1M, wallet balance, estimate-vs-actual KPI + per-kind table, breaker-tripped note), Users
table (quota % + window label, balance column). Every write goes through the in-app `ConfirmDialog` and is audited
by the backend. Vendor prices (dated schedule), per-hour STT, FX auto + override and reconciliation were CORE-A's.

---

## 21. Editor client status (EDITOR-UI, 2026-09-22)

Web (`web/src`): `lib/usageLimits.ts` (+test: Thai window labels, reset lines in the viewer's timezone,
baht, refusal parsing/wording, job-row states, `X-Noey-Device` id), `lib/usageEstimate.ts` (+test: wizard
request, start decision), `lib/useUsageEstimate.ts` (debounced `POST /usage/estimate`), `lib/api.ts`
(`Usage` §19 shape — no token fields; `getWallet`, `startTopup`; `ApiError.refusal`, `errorFromResponse`),
`lib/apiError.ts` (object `detail`), `lib/httpClient.ts` + `lib/authedFetch.ts` (device header),
`lib/videosLocalApi.ts` (+test: `allow_wallet` on analyze-video / transcribe-audio / plan-dub / reedit,
`estimateUsage`, `pollJob` treats `waiting_slot` as alive and `stopped` as a typed refusal),
`lib/useProjectPipeline.ts` (`waitingSlot`, per-start wallet consent, `billingStop`, `continueOnWallet`),
`components/settings/UsageCard.tsx` + `WalletCard.tsx`, `pages/SettingsPage.tsx` (usage tab),
`components/wizard/UsageEstimate.tsx`, `components/QuotaDialog.tsx`, `pages/WizardPage.tsx`,
`components/projects/RecutDialog.tsx` + `ProjectGridCard.tsx`, `pages/ProjectDetailPage.tsx`,
`pages/JobProgressPage.tsx`, `lib/noLeaks.test.ts` (no token wording in any screen string).
`GET /usage/stt` / `getSttUsage` and every token-count field are gone from the client.

Desktop (`desktop/app/src/renderer/src`, files present on this machine): the same `api.ts`, `httpClient.ts`,
`usageLimits.ts` (+test), `videosLocalApi.ts`, `useProjectPipeline.ts`, `SettingsPage.tsx` (usage tab;
checkout in the system browser), new `components/settings/UsageCard.tsx` + `WalletCard.tsx`; `LocalProject`
in `preload/index.ts` + `main/projects.ts` gains `allowWallet` / `billingStop`. The screens that are not in
this tree are PARITY.md rows ("Token billing — …").

---

## 22. Review fixes (2026-09-22) — what changed after CORE-B

The fourteen findings of the post-build billing review, all verified against the code and fixed
(two were duplicates). Deviations above, marked `(REVIEW)`, supersede the CORE-B rows they name.

| Area | Now |
|---|---|
| Pricing input | Measured on the server: `packages/video/ffmpeg_bin.py:measure_media` (fail closed → 422), staging in `.incoming-*`, `routers/videos_local.py:_stage_proxies / _measure_upload / _measure_stored_proxies`, `routers/videos.py:_measured_seconds_or_422`, `routers/effect_styles.py:_reference_seconds`. Stored proxy manifests carry `measuredSec` next to the client's `durationSec` (kept for the prompt's clip bounds) |
| Per-call guard | `guard.before_llm_call(... video_sec=, video_precision=) -> Admission(budget, input_tokens, max_tokens, input_charge)`; `guard.output_truncated()`; `guard.stt_clip_seconds()` |
| Gateway | pops `billing_video_sec` / `billing_video_precision` / `billing_input_tokens`; applies the output cap; `_settle_failed` (timeouts); `_record_cancelled` |
| Fault | `packages.core.errors.UserInputError`; `elevenlabs_stt.ElevenLabsInputRejected`; `runs.refunds_today` + `settings.billing_free_refunds_per_day`; admin `failed_runs_30d` |
| Security | proxy file names are keys only (`_safe_upload_name`); every stored proxy is `proxy_NNN.mp4` |
| Money | `WALLET_MOCK_TOPUP`; `topup.reverse_from_event`, `wallet.reverse_lot`, ledger kind `reversal` (web/desktop/admin label it) |
| Queue | lease renewed while waiting; `_close_orphaned_wait` in the worker |

Settings added: `BILLING_FREE_REFUNDS_PER_DAY` (3), `REFERENCE_MAX_SEC` (1200), `WALLET_MOCK_TOPUP` (false).
Stripe webhook events to enable in addition to §9.4: `charge.refunded`, `charge.dispute.created`,
`checkout.session.async_payment_failed` (`scripts/stripe_seed.py` prints `HANDLED_EVENTS`).

---

## 23. Editor Limits design + website plan features (2026-09-22)

Built after the workflow (docs/design/editor-limits.md §2–§6; docs/token-billing-plan.md §8):

- **Plan features** — `packages/billing/limits.py` `PlanLimits` gains `footage_sec`, `max_projects`, `music`,
  `transcode`, `queue_lead_sec` (values = noey-frontend `lib/plans.ts`); `packages/billing/plan_features.py`
  (checks + refusal bodies + `features_payload`). Enforced: `POST /videos/local` + `POST /videos`
  (`videos_local.enforce_new_project`: 403 `project_limit` on NEW projects only, 422 `footage_over_limit` on the
  declared length); every footage start route re-checks the MEASURED length in `billing_start.start_paid_run`
  (kinds `analyze_video` / `transcribe_audio` / `analyze_frames` / `server_pipeline`, +5 s tolerance);
  `POST /videos/{uid}/music` and `POST /videos/transcode` → 403 `plan_feature`; queue priority through
  `routers/videos.py:queue_priority_kwargs` (arq score set `queue_lead_sec` in the past: Pro 120 s "ahead",
  Studio+ and unlimited 600 s "first"; the slot re-queue in the worker does not keep the lead). Admin / enterprise
  pass everything. `GET /usage/me` adds `features` and `projects {count, max}`.
- **Plan switch** — `packages/billing/plan_switch.py`; `POST /billing/plan-preview {tier}` →
  `{tier,current,direction,due_now_satang,next_price_satang,effective_at,mode,exact}` (Stripe invoice preview
  when a subscription is live, else prorated by the remaining period, rounded up to the baht);
  `POST /billing/plan-switch {tier, consent}` → `{url|null, applied, effective_at}` — consent required for a paid
  target (422), Stripe checkout / portal-confirm URL when Stripe is configured, applied at once (upgrade) or
  scheduled (downgrade / Free) in the local mock (`topup.mock_allowed`), 503 anywhere else without Stripe.
  No migration.
- **Web** (`web/src`): `lib/planLadder.ts` (+test; plan rows, dialog copy, §4 notices, §2 banner), `lib/usageInfo.ts` +
  `lib/usageContext.tsx` (`UsageProvider` in App: `/usage/me` on mount / focus / 3 min), `lib/freshToken.ts`
  (moved out of SettingsPage), `components/shell/UsageBanner.tsx` (≥80 % window or payment grace; dismissal per
  window+reset in localStorage), `components/LimitNotices.tsx`, `components/settings/PlansCard.tsx` +
  `PlanChangeDialog.tsx` (settings usage tab), UsageCard "เปลี่ยนแผน" link, wizard pre-upload notices
  (footage / storage / projects — block "ถัดไป" and start) and the locked music row, MusicLane lock.
- **Desktop** (files present): same `api.ts` additions, byte-identical `lib/planLadder.ts` (+test), `PlansCard`,
  `PlanChangeDialog`, SettingsPage wiring, UsageCard link. The rest is PARITY.md.
