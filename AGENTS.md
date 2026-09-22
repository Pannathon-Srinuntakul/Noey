# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

# Noey Tiktok — Project Rules & Architecture

AI video-editing product for a TikTok **affiliate creator**, in two clients over
one backend: a **desktop app** (`desktop/`) and a **web build** (`web/`), both
cutting affiliate clips with provider-agnostic AI. The original 3D-data-world
analytics dashboard (`frontend/`), its 13 API routers and its DB tables were
REMOVED on 2026-09-09 — `PROJECT_REQUIREMENTS.md`/`ARCHITECTURE.md` describe
that removed system and are historical only.

## Hard Rules (non-negotiable)

1. **Git: personal account only.** This repo pushes to `git@github-personal:Pannathon-Srinuntakul/Noey.git`
   — the owner's PERSONAL GitHub (SSH key `~/.ssh/github_personal`, committer
   `pabeam27@gmail.com`). Claude may `add`, `commit`, `push` and read history here
   (owner, 2026-09-23, replacing the earlier "never touch git" rule). Never touch any
   other remote, never use a work/organisation account or credential, never force-push,
   never rewrite pushed history, and never commit secrets (`.env`, keys, tokens).
   `main` auto-deploys to Railway, so a push IS a production deploy: run the tests
   first, then watch the deployment.
2. **Account safety first.** The owner's affiliate account is the income source.
   Scraping breaches TikTok ToS and risks a ban. Every scraping change must respect
   the enforced cadence floor, stealth, and human-like pacing (see the `scraper` skill).
3. **No AI in the scraping path.** Playwright extracts data deterministically via
   selectors. AI is only for analysis/chatbot/prompt-cron over already-stored data.
4. **AI is provider-agnostic.** All model calls go through `packages/llm` (LiteLLM
   gateway) — never import a vendor SDK directly elsewhere. Cloud + local supported.
5. **Secrets never committed** (and, per rule 1, nothing is committed at all). Keep
   keys in `.env` / environment only.
6. **Test as you go.** When a module is finished, test it before moving on — don't batch
   testing to the end. Prefer fast unit tests (pytest / Vitest). Use Playwright (browser/
   e2e) **only when necessary** — it's slow and token-heavy; reserve it for flows that
   genuinely need a real browser, and keep those runs minimal and targeted to save tokens.
7. **Use framework scaffolders, don't hand-write boilerplate.** When creating an app or
   adding a package, use the framework's official generator so you get the standard
   structure for free — e.g. `npm create vite@latest` for the React app, `alembic init`
   for migrations, `playwright install` / `playwright codegen` for browser setup. Only
   hand-write files the scaffolder doesn't produce (small shared libs, glue, config).

8. **Keep web and desktop in step — write down every gap.** The two clients are
   one product and must move together. Whenever a feature, fix or behaviour
   change lands on ONE side only, record it in `PARITY.md` (what changed, which
   side has it, which side is missing it, and why) in the same session that
   makes the change. The note is the point: an undocumented gap is one nobody
   remembers to close.
   The one exception: something DELIBERATELY hidden on a side because that side
   cannot support it yet (e.g. a web feature that needs an API the browser does
   not have). That is a platform limit, not drift — do not add a parity note for
   it. Note only work that could exist on both and currently does not.

## Language & Stack

- **Backend (all of it): Python 3.12** — API, worker (scraper never built).
- **Clients: TypeScript + React (Vite)** — `web/` (browser, WebCodecs render) and `desktop/app` (Electron).
- Postgres + SQLAlchemy + Alembic; FastAPI; arq + Redis (background jobs); LiteLLM.

## Conventions

- Monorepo split: **`backend/` = all Python; `web/` + `desktop/app` = TypeScript/React.**
  Inside `backend/`: shared libs in `packages/`, deployable units in `services/`.
  Run all Python tooling (pytest, alembic, uvicorn) from `backend/`.
- Python: Ruff + mypy, type hints everywhere, Pydantic models at boundaries.
- TS: ESLint + Prettier, strict mode.
- Tests: pytest (backend), Vitest (web + desktop), Playwright only when a real browser is genuinely needed.
- Structured JSON logging; every scrape/AI run recorded in audit tables.

## DB Schema Architecture

Two-layer schema design in PostgreSQL:

- **`core` schema** — auth + platform: `users`, `tenants`, `memberships`, `jobs` (arq job status), `llm_usage_logs`, `stt_usage_logs` (per attempt / per file: rate-card `tokens`, `cost_thb`, `status`, `run_id`). Token billing: `ai_runs` (one paid run = reservation + estimate vs actual), `usage_accounts` (rolling 5-hour/weekly/monthly windows, the per-user lock row), `wallet_lots` + `wallet_ledger` (top-up baht balance), `fx_rates`, `vendor_invoices`.
- **`tenant_<slug>` schema** — per-tenant business data: `video_projects`, `effect_styles`.
  (The analytics/CSV tables, `custom_table_meta` + `udt_*`, chat, prompts and
  scrape-run tables were dropped 2026-09-09 with the dashboard — migration
  `32f7cd8e7c1d`.)

Every API request sets `SET search_path TO "tenant_<slug>", core` via `deps.py` so SQLAlchemy models resolve to the right schema automatically. `packages/db/tenancy.py` owns schema creation/drop and search_path SQL generation.

## Code Map (current state)

- **`backend/packages/`** — shared libs:
  - `core/` — `settings.py` (Pydantic settings from `.env`), `logging.py` (structured JSON), `errors.py` (structured error helpers).
  - `auth/` — JWT access + refresh tokens (`tokens.py`), bcrypt hashing (`hashing.py`), Fernet encryption (`crypto.py` — for AI keys stored in DB).
  - `db/` — `base.py`, `session.py`, `config.py`, `upserts.py`, `tenancy.py` (schema management).
    - `models/core_auth.py` — Tenant, User, Membership, Job (core schema).
    - `models/custom_table.py` — CustomTableMeta (user-defined table registry, per-tenant).
    - `models/tiktok_csv.py` + other analytics models — analytics tables (per-tenant).
    - `models/chat_session.py` — ChatSession, ChatMessage (per-tenant; auto-summarize at 40 msgs).
    - `models/video_project.py` — VideoProject (per-tenant; statuses: pending/processing/done/error/cancelled; modes: talking_head/dub_first).
    - `models/llm_usage.py` — per-user token usage + cost tracking.
    - `models/app_setting.py` — key-value app settings (per-tenant).
    - `models/scrape_run.py` — scrape run audit log.
  - `llm/` — LiteLLM gateway (`gateway.py`: `acompletion`, `acompletion_stream_thinking` for streamed extended-thinking, `complete`, `chat_once` — with retry/timeout/error-phase classification), `config.py` (`sync_llm_env`, `model_params`, `call_kwargs`, `vision_call_kwargs`, `anthropic_file_kwargs`, `model_supports_effort`), `files.py` (Anthropic Files API upload/delete for vision frames — via LiteLLM, never the `anthropic` SDK), `tools.py`, `usage.py` (per-user token tracking via ContextVar — set `UsageCtx` before any LLM call). **Only AI entry point.**
  - `billing/` — token billing (**spec: `docs/token-billing-plan.md`; design + every deviation + API contracts: `docs/token-billing-design.md`**). `rate_card.py` (fixed, versioned vendor→token rates), `limits.py` (plan windows/concurrency/storage), `estimate.py` (server-side run estimate, priced on footage the SERVER measured — `ffmpeg_bin.measure_media`, never a client-stated length), `runs.py` (reserve at start / settle at end, rolling windows, concurrency slots, sweeper, daily refund cap), `guard.py` (per-call ceiling + output cap in the gateway, circuit breaker), `metering.py` (durable usage rows + outbox), `vendor_limits.py`, `wallet.py` + `topup.py` (baht balance, Stripe one-time checkout, refund/dispute reversal), `plan_change.py`, `plan_switch.py` (editor plan change: `POST /billing/plan-preview` / `plan-switch`, consent checked server-side), `plan_features.py` (footage / project count / music / server transcode / queue priority — the website's `lib/plans.ts` is the source of truth), `free_tier.py`, `fx.py`, `vendor_cost.py`. Every AI route calls `services/api/billing_start.py:start_paid_run`; every AI worker task is wrapped in `tasks.billed_task`. Users never see token counts.
  - `video/` — `storage.py` (file paths under `backend/data/`), `ffmpeg_bin.py` (ffmpeg/ffprobe wrapper, reads `FFMPEG_PATH`), `timeline.py` (transcript → cut list, AI highlight planning), `scene.py` (frame extraction for dub_first), `elevenlabs_stt.py` (**the only speech-to-text path** — ElevenLabs Scribe client + the word-gap arithmetic that decides the silence cut), `caption.py` (ASS subtitle generation), `overlay.py` (visual effects/stickers render), `stickers.py` (sticker asset resolution), `face_tracker.py` (face bbox tracking), `style_profile.py` (PySceneDetect + Codex Vision → Style Profile JSON), `assets.py` (SFX catalog + rule-based placement), `fonts.py` (bundled Thai-capable caption fonts in `backend/data/fonts/`), `s3.py` (S3/R2 sync for multi-host deployments — no-op when `S3_BUCKET` unset).
    - Effects layer (see "Effects Layer" below): `effects.py`, `effects_ai.py`, `effects_catalog.py`, `effects_codegen.py`, `effects_render.py`, `effects_capcut.py`, `transforms.py`.
- **`backend/services/api/`** — FastAPI app. Routers: `auth`, `workspace`, `analytics`, `import_csv`, `metrics`, `products`, `creators`, `market`, `prompt_cron`, `runs`, `chat`, `settings`, `custom_tables`, `table_io`, `jobs`, `videos`, `videos_local`, `usage` (`GET /usage/me` percent-only windows, `POST /usage/estimate`), `wallet` (`GET /wallet/me`, `POST /wallet/checkout`), `releases` (unauthenticated presigned-S3 redirect for the desktop installer). Admin billing endpoints (window reset, wallet adjust, estimate accuracy, reconciliation, FX, billing config, circuit breaker) live in `routers/admin.py` — see docs/token-billing-design.md §19. Logic split: `queries.py` (read), `csv_importer.py`, `chat_service.py`, `schemas.py`, `deps.py` (DI + JWT extraction + search_path injection).
- **`admin/`** — owner-only admin dashboard (Next.js 16, `create-next-app`, BFF: the browser never sees the API; port 3001; Docker `admin` service). Built from the design `Admin Dashboard.dc.html`. Every baht is computed in ONE place, `src/lib/money.ts` (tested), from the usage FACTS the backend returns; `src/proxy.ts` sets a per-request nonce CSP and refreshes the session; Server Actions in `src/app/actions.ts` re-check Origin + session. Backend side: `routers/admin.py` behind the single guard `services/api/admin_deps.py:current_admin` (admin JWT audience `noey-admin` + server-side `admin_sessions` row re-read per request: is_admin, is_active, token_version, 30-min idle), login = password → emailed 6-digit code (`packages/admin/auth.py`), audit log `core.admin_audit_events`, cost assumptions `packages/admin/cost_config.py`, usage aggregates `packages/admin/metrics.py`, plan price edits `packages/admin/pricing.py` (Stripe: new Price + lookup-key transfer; no Stripe: `plan_price_overrides` served by GET /billing/plans) then noey-frontend `POST /api/revalidate-prices`. `tests/test_admin_security.py` walks app.routes — every new `/admin` route is denial-tested automatically. Local demo data: `backend/scripts/seed_admin_demo.py` (localhost DB only).
- **`backend/services/worker/`** — arq background worker (queue `arq:default`). Tasks: the video chains (`ingest_video` … `plan_dub_timeline`, the `*_local` family), `transcode_for_web`, and the `sweep_housekeeping` cron. API enqueues → returns `job_id` → the client polls `GET /jobs/{job_id}`. Run: `python -m services.worker`.
- **`backend/scripts/`** — one-off operational/smoke scripts (NOT pytest): `check_project.py` (inspect a video_project row), `probe_stream_thinking.py` (verify streamed thinking chunks), `vision_smoke_test.py` (Files API vs base64 vision latency), `probe_elevenlabs.py` (Scribe on a real Thai clip → token shape, gap distribution, logprob spread, wall clock). Run from `backend/` with `python scripts/<name>.py`.
- **`backend/packages/db/alembic/`** — migrations live here (not `backend/alembic`); `alembic.ini` at `backend/` points `script_location` to it. Run alembic from `backend/`.
- **`desktop/`** — standalone desktop app for the AI video-edit feature, **both modes** (dub_first + talking_head) end-to-end (see `DESKTOP_VIDEO_APP_REQUIREMENTS.md` + `desktop/README.md`). Isolated from `backend/` — additive backend changes only. `desktop/app/` = Electron + React + TS (electron-vite, Tailwind v4): own JWT login against existing `/auth/*` (no session sharing), safeStorage token store, local project registry (`userData/projects/<uid>/project.json`), `media://` privileged protocol for local video preview, mode-aware wizard (`pages/WizardPage.tsx` — dub: analyze → silent cut, which is where a dub run normally ENDS; the voiceover + final render are optional work offered afterwards. talking_head: extract-audio → server transcribe+plan → local render), TimelineEditor ported from the web editor (IO seam in `lib/editorApi.ts`). `desktop/sidecar/` = Python render engine spawned by Electron main; imports `backend/packages/video` read-only via `sys.path` (`bootstrap.py`, `NOEY_BACKEND_DIR` override); JSON-lines protocol on stdout (`ping`/`probe`/`ingest`/`extract-frames`/`render-silent`/`render-final`/`extract-audio`/`render-timeline`), logs on stderr. Video files stay on the user's machine — only frame JPEGs (dub) / speech WAVs (talking_head) upload for AI. User-visible name is **Noey Studio** (renamed from Noey Video Edit 2026-09-22); `appId`, package `name` (installer filename in `routers/releases.py`) and the packaged userData folder (`Noey Video Edit`, pinned in `main/index.ts`) keep the old identifiers on purpose so updates keep users' projects and login. Packaging: PyInstaller sidecar + bundled ffmpeg + electron-builder NSIS/dmg (`npm run build:win`).
- **Local-render backend surface** (additive): `routers/videos_local.py` (`POST /videos/local`, `POST /videos/{uid}/analyze-frames`, `POST /videos/{uid}/plan-dub`, `POST /videos/{uid}/transcribe-audio`, `GET/PUT /videos/{uid}/local-timeline`, `PATCH /videos/{uid}/local-status`, `PUT /videos/{uid}/local-edit-script`), arq tasks `analyze_dub_local` + `plan_talking_local`, `video_projects.origin/local_meta` columns. Shared cores extracted from worker tasks into `packages/video/`: `dub_ai.py` (dub prompts + LLM calls), `dub_render.py` (dub ffmpeg cores), `plan_core.py` (talking_head planning incl. Haiku passes), `elevenlabs_stt.py` (Scribe transport + transcript assembly), `audio_extract.py` (speech WAV chain), `render_common.py` (SRT + CapCut bundle) — worker and sidecar/API both use them; do not fork their behavior.

## Effects Layer (AI-assisted effects/stickers on top of the cut)

Spec: `REMOTION_EFFECTS_REQUIREMENTS.md`; user-facing walkthrough: `EFFECTS_USER_GUIDE.md`.

A stage that runs **after** the cut is rendered. It never touches the cut files —
`edit_script.json` / `timeline.json` decide *which footage plays when*; a sibling
`effects.json` (schema in `packages/video/effects.py`) decides *what sits on top /
how footage is transformed*. Keep that split.

Two execution paths, keyed by instance `kind`:

- `kind="overlay"` — a **Remotion** component (TS/React) renders a transparent-background
  clip that ffmpeg composites on top. Implementations live in
  `desktop/node-sidecar/src/compositions/registry.ts`.
- `kind="transform"` — no component; an ffmpeg filter chain applied to the real footage
  (punch-zoom, pan, crop-reframe). Implementations + `TRANSFORM_REGISTRY` in
  `packages/video/transforms.py`.

`packages/video/effects_catalog.py` is the single Python-readable description of the
**whole** catalog (both halves) — it's injected into the AI prompt and used to validate/
clamp model output. Transform entries derive from `TRANSFORM_REGISTRY`; overlay entries
**mirror** `registry.ts`, so adding/changing an overlay means editing both files.

`effects_render.py` composites everything in a **single ffmpeg pass** (one filter_complex),
not one re-encode per effect. `effects_capcut.py` exports overlays as ProRes 4444 .mov +
`manifest.json` (transforms are baked and only noted).

**AI never generates code at render time** in the normal path: `effects_ai.py` (Gemini,
own prompt/schema/model setting) only *composes* catalog components into placed instances.
The escape hatch is `effects_codegen.py`, which asks a model to write a new Remotion
component — its output is **untrusted input**, must pass `node-sidecar/src/codegenValidate.mjs`
(acorn AST allowlist) before ever being bundled or executed. Read that file's security
model before touching it.

Surface: `POST /videos/{uid}/plan-effects` (upload cut proxy + optional steering prompt +
script → arq `plan_effects_local`), `GET/PUT /videos/{uid}/effects`, per-project codegen
(`POST /videos/{uid}/generate-effect-component`) and the project-independent Studio
variant (`POST /videos/effects/generate-component`) — all in `routers/videos_local.py`.

**Effect Styles** (reusable per-user AI editing style, distilled once, reused on every
placement run): `packages/db/models/effect_style.py` (`EffectStyle`, per-tenant, status
pending/ready/error), `packages/video/effects_style.py` (checklist-driven Gemini
distillation of a reference clip and/or text description → stored prose), arq
`distill_style_local` (`services/worker/tasks.py`), CRUD in
`routers/effect_styles.py` (`/effect-styles`). The stored prose is spliced into
`EFFECTS_PLACEMENT_SYSTEM` (`effects_ai.py`, `__STYLE_BLOCK__` token) on every later
placement run instead of re-uploading the reference video each time.

**Desktop UI for the effects layer** (desktop/app):
- **Effects Studio** (`pages/EffectsStudioPage.tsx`, header "สตูดิโอ" button) — global,
  cross-project asset management: browse/live-preview registry components
  (`@remotion/player` via `components/EffectLivePreview.tsx` — trusted registry
  components ONLY, never AI `componentSource`), import stickers, AI-generate new
  components (prompt + reference image → preview rendered through the validated
  node-sidecar path), build templates. Assets live in `userData/effects-library/`
  (`templates.json`, `stickers/`, `generated/` — see `src/main/library.ts`); served to
  `<video>`/`<img>` via `media://library/<rel>` (`mediaPath.ts libraryPathForUrl`).
- **Per-project effects editor** (`EffectsCanvasEditor.tsx` — CapCut-style, fullscreen):
  live overlay preview via `@remotion/player` synced to the `<video>` playhead, overlays
  DRAGGED directly on the video (drag edits props x/y; punch-zoom drag sets focusX/Y),
  timeline lanes below (drag = move, right edge = resize), right rail for remaining props
  + add menu (template / component / AI library / generate new), stop button aborts the
  AI run (AbortSignal through `effectsPipeline` + server `/cancel`). Generated
  (untrusted) instances never execute in the renderer — placeholder chip until render.
  dub_first gets the button from `waiting_vo` (on `final_silent.mp4`); after the VO/final
  render, `useProjectPipeline.runFinal` auto re-applies a non-empty effects.json onto
  `final.mp4`.
- **Component library** (`node-sidecar/src/compositions/`): beyond the originals
  (text-reveal, sticker-badge, shape-highlight, light-leak, lottie/image sticker), a set
  ported from MIT community libraries (remotion-scenes, remocn, Onda, RemotionUI,
  TikTokTextBox — each file header names its source): `text-neon`, `text-glitch`,
  `text-typewriter`, `text-shimmer`, `price-counter`, `tiktok-text-box`,
  `particle-burst` (confetti/sparkle/heart × burst/fall), `vibe-wash`
  (grain/VHS/vignette), `animated-emoji`. Shared helpers: `textFit.ts` (Thai-aware
  wrap + measure + auto-shrink — use it in ANY new text component), `safeArea.ts`,
  `FxCanvas.tsx`. Adding a registry entry auto-populates the app picker via the `@fx`
  alias — no app-side edit needed, but add it to `EffectsCanvasEditor.tsx`
  `LIVE_PREVIEWABLE` if it previews safely (no local asset paths).
- **`@remotion/effects` (glow/dropShadow/shader effects) IS wired in**: Remotion's
  bundled headless shell ships the `canvas-draw-element` flag pre-enabled (v4.0.455+)
  and `render.mjs`/`codegen.mjs` pass `chromiumOptions: { gl: 'angle' }`, so it renders
  on clean machines. It composites via `<HtmlInCanvas>`, which the app's live Player
  preview (older Electron Chromium) lacks — always route through
  `compositions/FxCanvas.tsx` or an `isHtmlInCanvasSupported()` guard so preview
  degrades to plain children.
- **Animated emoji assets**: `@remotion/animated-emoji` ships code only. 28 curated
  `.webm` are downloaded at build time by `node-sidecar/scripts/fetch-emoji.mjs`
  (cached; run automatically from `prepare-resources.mjs`), staged into the installer,
  and located at runtime via `NOEY_EMOJI_DIR` (`main/nodeSidecar.ts`) →
  `compositions/emojiAssets.ts`. To add an emoji, edit `EMOJI_CHOICES` **and** the
  mirror list in `fetch-emoji.mjs`.
- **Component quality**: overlay components carry their own frame-safety
  (`compositions/safeArea.ts clampCenter`) and layout math — text-reveal wraps Thai via
  `Intl.Segmenter` + `@remotion/layout-utils` measure/auto-shrink (max 2 lines, centered);
  `size` on shape-highlight is the FULL diameter. Server-side belt+suspenders in
  `effects_catalog.py normalize_props_for_component` (numeric clamps + text truncation).
  Regenerating placement passes the rejected effects.json back as `<previous_attempt>`
  so Gemini produces a different take. After editing compositions, re-run
  `npm run prebundle` in node-sidecar or renders keep using the stale bundle.
- The renderer imports the REAL registry via the `@fx` vite/tsconfig alias
  (`../node-sidecar/src/compositions`); `lib/effectsCatalog.ts` derives its overlay
  entries from it (transforms stay local data — Python owns them). The app pins the
  same `remotion@4.0.489` as the node-sidecar.

**Not built yet**: no `services/scraper`. Live scraping is remaining work; current data path is CSV import via the API. Desktop app: auto-update, code signing, macOS build (needs a Mac).

**Video pipeline deps**: ffmpeg must be available. Set `FFMPEG_PATH=C:\path\to\ffmpeg.exe` in `.env`, or install via `winget install Gyan.FFmpeg`. The worker auto-discovers it from `LOCALAPPDATA/Microsoft/WinGet` on Windows.
Uploaded clips land in `backend/data/video_uploads/<project_uid>/`; rendered output in `backend/data/video_outputs/<project_uid>/`.

**Optional S3/R2 storage**: set `S3_BUCKET` (+ `S3_ENDPOINT_URL` for Cloudflare R2) to sync video files between API and worker hosts. When unset, all `packages/video/s3.py` methods are no-ops and the local filesystem is sole storage.

**`loadtest/`** — capacity testing WITHOUT paying a vendor: `LOADTEST_FAKE_AI=1`
makes `packages/llm/fake.py` answer every model call, Files-API upload and
speech-to-text request with a canned, parseable result after a realistic delay
(everything else — reservation, guard, vendor slots, metering, queue, DB, Redis,
S3 — stays real). Settings REFUSE to load it when the environment says
production. `backend/scripts/seed_loadtest.py` makes the `lt-*@loadtest.noey.local`
accounts; `loadtest/k6/editor.js` + `loadtest/runner/Dockerfile` drive one editor
session per virtual user from a runner deployed beside the stack under test (never
the owner's laptop). See `loadtest/README.md`.

**`docs_raw/`** — raw TikTok Affiliate API documentation (markdown); reference when building scraper or API integrations.

## Capacity (measured, not guessed)

`docs/load-test-2026-09-22.md` found the whole stack's ceiling was a
15-connection SQLAlchemy pool per process; `docs/load-test-2026-09-23.md` is the
re-run after the fix (100 users: 319 jobs completed and none lost, against 52
completed and 72 lost). Four things hold that up — change any of them together,
not alone:

- **Pool size is explicit**: `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`,
  `DB_POOL_TIMEOUT_SEC`, `DB_POOL_RECYCLE_SEC`. Production runs API 20+10,
  worker 40+20. The worker's pool must stay ≥ `WORKER_MAX_JOBS`.
- **`API_WORKERS`** gives the API more than one core (one uvicorn process is one
  event loop). Each worker is a process with its OWN pool, so
  `API_WORKERS × (pool + overflow)` is what reaches Postgres (500
  `max_connections` there, measured 2026-09-23). Migrate + seed run under a
  Postgres advisory lock because every process starts at once.
- **`GET /jobs/{id}` answers from Redis** (`packages/db/job_cache.py`). The
  worker mirrors each status after the row commits; the endpoint falls back to
  Postgres on a miss, a foreign tenant, or a running job old enough for the
  stale reaper. Job ids repeat (`vlocal_<uid[:8]>`), so the cache is dropped on
  enqueue and on cancel — otherwise the previous run's terminal status answers
  the next run's first polls.
- **A job waiting on the AI does not hold a connection** —
  `tasks._release_connection` commits before each long model call.

Vendor quota: the DAILY request cap is the real ceiling (Tier 1 = 10,000 Flash /
250 Pro a day; a cut uses 4-5 Flash calls). `packages/billing/vendor_limits.py`
counts it per Pacific day alongside the per-minute window, fails fast with
`VendorDailyLimit` when it is spent, warns once a day at
`GEMINI_RPD_ALERT_RATIO`, and `GET /admin/vendor-quota` shows it.

## Skills (load the matching one before working in that area)

Skill files live in `.Codex/skills/<name>/`.


- `scraper` — Playwright scraping, safety floor, stealth, selectors, OTP/session.
- `backend-api` — FastAPI service structure and conventions.
- `llm-gateway` — provider-agnostic AI usage (cloud + local).
- `database` — SQLAlchemy models + Alembic migrations.

## Commands

All Python commands run from `backend/`. Web commands run from `web/`; desktop from `desktop/app`.

**Backend**
```bash
# Run API server
cd backend && uvicorn services.api.main:app --reload

# Run arq background worker (requires Redis)
cd backend && python -m services.worker

# Probe ElevenLabs Scribe on a real clip before tuning cut constants
cd backend && python scripts/probe_elevenlabs.py path/to/clip.mp4

# All tests
cd backend && pytest

# Single test file
cd backend && pytest tests/test_api.py

# Single test by name
cd backend && pytest tests/test_api.py::test_function_name -v

# Lint + type check
cd backend && ruff check . && mypy .

# Alembic migrations
cd backend && alembic upgrade head
cd backend && alembic revision --autogenerate -m "description"
```

**Web**
```bash
cd web && npx vite --port 5174   # dev server
cd web && npx vite build         # production build
cd web && npm run lint           # ESLint
cd web && npx vitest run         # Vitest unit tests
```

**Desktop app** (from `desktop/app` unless noted)
```bash
npm run dev                     # Electron dev with HMR
npm run test                    # Vitest
npm run typecheck && npm run lint
npm run build                   # production bundles
cd desktop/sidecar && python -m pytest tests/   # sidecar tests (same Python env as backend)
```

**Remotion node-sidecar** (from `desktop/node-sidecar`)
```bash
npm run studio                  # Remotion Studio to preview overlay components
npm run prebundle               # bundle compositions for the packaged app
npm run test                    # Vitest (incl. codegenValidate allowlist tests)
```

**Infrastructure**
```bash
docker compose up -d postgres   # start only postgres
docker compose up -d redis      # start only redis (required for arq worker)
docker compose up -d            # start all containers
```

## Reply language

Converse with the user in **Thai**. All persisted artifacts (code, docs, skills) in
**English**.
