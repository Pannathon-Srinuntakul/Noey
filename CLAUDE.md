# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- **`core` schema** — auth + platform: `users`, `tenants`, `memberships`, `jobs` (arq job status), `llm_usage_logs`, `stt_usage_logs` (per attempt / per file: rate-card `tokens`, `cost_thb`, `status`, `run_id`). Token billing: `ai_runs` (one paid run: estimate vs what it actually spent — charged per vendor request as the run goes, nothing reserved), `usage_accounts` (rolling 5-hour/weekly/monthly windows, the per-user lock row), `wallet_lots` + `wallet_ledger` (top-up baht balance), `fx_rates`, `vendor_invoices`.
- **`tenant_<slug>` schema** — per-tenant business data: `video_projects`, `effect_styles`.
  (The analytics/CSV tables, `custom_table_meta` + `udt_*`, chat, prompts and
  scrape-run tables were dropped 2026-09-09 with the dashboard — migration
  `32f7cd8e7c1d`.)

Every API request sets `SET search_path TO "tenant_<slug>", core` via `deps.py` so SQLAlchemy models resolve to the right schema automatically. `packages/db/tenancy.py` owns schema creation/drop and search_path SQL generation.

## Code Map (current state)

- **`backend/packages/`** — shared libs:
  - `core/` — `settings.py` (Pydantic settings from `.env`), `logging.py` (structured JSON), `errors.py` (structured error helpers).
  - `auth/` — JWT access + refresh tokens (`tokens.py`), bcrypt hashing (`hashing.py`), Fernet encryption (`crypto.py`).
  - `db/` — `base.py`, `session.py` (engine + explicitly sized pool; plus a `NullPool` LIFELINE engine for status writes that must not queue behind it), `config.py`, `tenancy.py` (schema management), `job_cache.py` (Redis mirror of `core.jobs` — `GET /jobs/{id}` reads it first; see "Capacity" below).
    - `models/core_auth.py` — Tenant, User, Membership, Job (core schema).
    - `models/video_project.py` — VideoProject (per-tenant; statuses incl. pending/processing/waiting_vo/done/error/paused_quota/cancelled; modes: see "Video modes" below).
    - `models/effect_style.py` — EffectStyle (per-tenant; `kind` = effects style or cut style; status pending/ready/error).
    - `models/llm_usage.py` + `models/stt_usage.py` — per-user token/STT usage + cost tracking.
  - `llm/` — LiteLLM gateway (`gateway.py`: `acompletion`, `acompletion_stream_thinking` for streamed extended-thinking, `complete`, `chat_once` — with retry/timeout/error-phase classification), `config.py` (`sync_llm_env`, `model_params`, `call_kwargs`, `vision_call_kwargs`, `anthropic_file_kwargs`, `model_supports_effort`), `files.py` (Anthropic Files API upload/delete for vision frames — via LiteLLM, never the `anthropic` SDK), `tools.py`, `usage.py` (per-user token tracking via ContextVar — set `UsageCtx` before any LLM call). **Only AI entry point.**
  - `billing/` — token billing (**spec: `docs/token-billing-plan.md`; design + every deviation + API contracts: `docs/token-billing-design.md`**). `rate_card.py` (fixed, versioned vendor→token rates), `limits.py` (plan windows/concurrency/storage), `estimate.py` (server-side run estimate, priced on footage the SERVER measured — `ffmpeg_bin.measure_media`, never a client-stated length), `runs.py` (open a run holding nothing / charge each vendor request as it goes / settle the difference at the end, rolling windows, the quota snapshot a run pauses on, concurrency slots, sweeper, daily refund cap), `guard.py` (per-call run ceiling + what is left of the plan's window + output cap in the gateway, circuit breaker), `metering.py` (durable usage rows + outbox), `vendor_limits.py`, `wallet.py` + `topup.py` (baht balance, Stripe one-time checkout, refund/dispute reversal), `plan_change.py`, `free_tier.py`, `fx.py`, `vendor_cost.py`. Every AI route calls `services/api/billing_start.py:start_paid_run`; every AI worker task is wrapped in `tasks.billed_task`. Users never see token counts. **Nothing is reserved at start** (owner, 2026-09-26): the only pre-flight refusals are `footage_over_limit` and `run_too_large` (a run bigger than the plan's largest enforced window even when that window is empty) — both about impossibility, not about having enough left. Running out of quota mid-run PAUSES the project in `paused_quota`, carrying the window, its reset time and whether the balance covers finishing; the work is kept and resumed from the stage it stopped at. Footage caps for the modes that send the whole project to the model in ONE video request (`dub_first`, `highlight`) are derived in `limits.py` from the model's input context ÷ the per-second video token cost, capped by the owner's one-hour rule: **1 hour at Standard, ~44 minutes at High**. An unlimited account skips the hour but never the context ceiling.
  - `video/` — `storage.py` (file paths under `backend/data/`), `ffmpeg_bin.py` (ffmpeg/ffprobe wrapper, reads `FFMPEG_PATH`), `timeline.py` (transcript → cut list, AI highlight planning), `scene.py` (frame extraction for dub_first), `elevenlabs_stt.py` (**the only speech-to-text path** — ElevenLabs Scribe client + the word-gap arithmetic that decides the silence cut), `stt_pricing.py` (Scribe cost → usage rows), `speech_select.py` (speech modes: `select_highlights` = mode A long clip → N clips, `select_scenes` = mode B pick segments), `audio_edges.py` (cut-boundary snapping), `beat_analysis.py` (librosa beat grid for background music), `caption.py` (ASS subtitle generation), `face_tracker.py` (face bbox tracking), `fonts.py` (bundled Thai-capable caption fonts in `backend/data/fonts/`), `s3.py` (S3/R2 sync for multi-host deployments — no-op when `S3_BUCKET` unset), `quality.py` (vendor-neutral Engine lite/pro × Precision standard/high tiers → provider settings; the only tier→model mapping).
    - Effects layer (see "Effects Layer" below): `effects.py`, `effects_ai.py`, `effects_render.py`, `transforms.py`.
    - Dub cut prompts are **versioned**: the LIVE prompts are in `dub_ai.py` itself (`DUB_EDIT_SYSTEM_VIDEO` / `_NO_VO` + `DEFAULT_CUT_STYLE_PROSE`); `dub_ai_v1.py` is the rollback (`DUB_PROMPT_VERSION=v1`) and `dub_ai_v2.py` is a frozen snapshot nothing selects. Any other value means the live set. Edit the live prompt in `dub_ai.py`; never edit the frozen files.
    - The two live video prompts (`DUB_EDIT_SYSTEM_VIDEO` / `_NO_VO`) are assembled from shared `_VIDEO_*` section constants — edit a rule once, in its section; only role/method step 6/video model/script/grouping/verify/output differ per mode. Rules that must hold under ANY cut style (safety, `<distinct_shots>` = never the same shot twice: no reused moment, no second take of an action (best take on screen, others to `alternates`), no two cuts from neighbouring seconds of one hold — deliberately narrow, since different gestures/parts of one setup make the multi-angle montage the default style wants, `<reject_prep>`, bounds) live in the base prompt, never in `DEFAULT_CUT_STYLE_PROSE` — a saved cut style replaces the `<editing_style>` block wholesale. The post-video instruction tail (`build_dub_edit_instruction_text_video`) is shared by both modes and read last, so it carries only per-request numbers plus rules measured to need restating there — never voiceover wording or editing-style guidance. Keep every rule product-agnostic (clips span fashion, skincare, gadgets, …); only `<reject_safety>` is apparel-specific on purpose. Its two relaxations are owner decisions (2026-09-21) — STYLING IS NOT UNDRESS (a layer worn open or draped off the shoulder and held as a pose is a look; the mid-change moment is still a transition) and a narrow PRODUCT EXCEPTION (upper-body underwear/swimwear tops shown under an open or draped layer, removable pads held up). Do not widen or drop either without asking; nothing below the waist is relaxed. `DUB_EDIT_SYSTEM` (Claude + frames) is legacy and pinned by tests. Measured on a shoe review (2026-09-21): pacing is capped by cut LENGTH (~0.8–2s, hook/CTA ≤3s), never by cuts-per-line; a product ON or IN USE and shown to camera is the demo, not prep; moving to PRESENT the product is content, only walking to/from the camera is production. `timeline.pull_back_clip_tails` keeps cuts out of the last 2.2s of long takes (the walk up to stop recording). Regression-test prompt changes on an apparel try-on AND a handheld product clip.
    - **Shot swap alternates (R18b)**: v2 edit-script segments carry `alternates` (≤3 backup shots + one-line Thai `note`, returned inside the SAME analysis call — never an extra model call). The field is REQUIRED in the Gemini response schema with empty = none (enforced decoding never fills an optional field — measured live 2026-09-01, 0/12 twice), restated in the v2 instruction tail, and validated in code by `timeline.py:sanitize_segment_alternates` (per-clip bounds silent-drop, >50% overlap with the main window drop, cap 3, NO minimum length at plan time — the length rule belongs to the desktop's locked regime). Empty arrays are stripped, so stored scripts still omit the field when there are no backups.
- **`backend/services/api/`** — FastAPI app. Routers: `admin` (admin dashboard API — see `admin/` below), `auth`, `billing`, `contact`, `jobs`, `videos`, `videos_local`, `effect_styles`, `usage` (`GET /usage/me` percent-only windows, `POST /usage/estimate`), `wallet` (`GET /wallet/me`, `POST /wallet/checkout`), `transfer` (phone→web video courier: single-use ticket, unauthenticated upload where the token is the credential, deleted the moment the web pulls the files), `releases` (unauthenticated presigned-S3 redirect for the desktop installer). `deps.py` = DI + JWT extraction + search_path injection.
- **`backend/services/worker/`** — arq background worker (queue `arq:default`). Tasks: the server-render video chain (`ingest_video`, `transcribe_video`, `plan_edit`, `render_video`, `analyze_dub_first`, `render_dub_silent`, `plan_dub_timeline`), the desktop/local chain (`analyze_dub_local`, `analyze_dub_video_local`, `plan_talking_local`, `plan_speech_local`, `reedit_dub_scenes_local`, `plan_effects_local`, `distill_style_local`), `transcode_for_web`, and the `sweep_housekeeping` cron (transcode + transfer scratch, stale job rows). API enqueues → returns `job_id` → the client polls `GET /jobs/{job_id}`. Run: `python -m services.worker`.
- **`backend/scripts/`** — one-off operational/smoke scripts (NOT pytest): `check_project.py` (inspect a video_project row), `probe_stream_thinking.py` (verify streamed thinking chunks), `vision_smoke_test.py` (Files API vs base64 vision latency), `probe_elevenlabs.py` (Scribe on a real Thai clip → token shape, gap distribution, logprob spread, wall clock). Run from `backend/` with `python scripts/<name>.py`.
- **`backend/packages/db/alembic/`** — migrations live here (not `backend/alembic`); `alembic.ini` at `backend/` points `script_location` to it. Run alembic from `backend/`.
- **`desktop/`** — standalone desktop app for the AI video-edit feature (see `DESKTOP_VIDEO_APP_REQUIREMENTS.md` + `desktop/README.md`). Isolated from `backend/` — additive backend changes only. `desktop/app/` = Electron + React + TS (electron-vite, Tailwind v4): own JWT login against existing `/auth/*` (no session sharing), safeStorage token store, local project registry (`userData/projects/<uid>/project.json`), `media://` privileged protocol for local video preview, mode-aware wizard (`pages/WizardPage.tsx`), timeline editor (`TimelineRoute.tsx`), effects/cut Style studio (`EffectsStudioPage.tsx`), voiceover (`VoiceoverPage.tsx`), app-level job progress (`JobProgressPage.tsx`). Long AI work runs at app level (`main/remoteJobs.ts`, `lib/fxJobs`) so leaving a screen does not kill it. R18b shot swap: `components/projects/ShotSwapModal.tsx` + `lib/shotSwap.ts` (swap a shot for an AI-returned `alternates` backup, ประกอบใหม่ locally — zero AI calls per swap round; free length regime before the voiceover / locked after, where the alternate is trimmed to the original durationSec anchored on matchedFrameTime and the planned timeline is re-pointed mechanically instead of re-planned), entry button `ปรับช็อต` on `ProjectDetailPage`, revert via the R12 `previousRender` mechanism; clicking a tray thumb previews the window in the app's `VideoModal` (new additive `stopAtSec` prop pauses at the window's end). Taste log: `main/tasteLog.ts` appends `shot_swap`/`shot_swap_revert`/`recut_note` events to `userData/taste-log.jsonl` at COMMIT only — collection-only this round, never fed to any prompt (R19 distills later). Phone/LAN surface in `main/`: `lanReceive.ts` (รับจากมือถือ / ส่งไปมือถือ over LAN), `remoteAccess.ts` + `remotePage.ts` + `remoteApi.ts` (phone remote = a switch, QR is a single-use pairing ticket → HttpOnly device cookie), `apiProxy.ts`. `desktop/sidecar/` = Python render engine spawned by Electron main; imports `backend/packages/video` read-only via `sys.path` (`bootstrap.py`, `NOEY_BACKEND_DIR` override); JSON-lines protocol on stdout (`ping`/`probe`/`ingest`/`extract-proxy`/`proxy-one`/`render`/`render-silent`/`render-final`/`render-timeline`/`render-highlights`/`render-effects`/`render-ai-preview`/`extract-audio`/`mix-music`), logs on stderr; outputs are written atomically (`atomic.py`: staged `.part` + faststart) so a file that exists is complete. Video files stay on the user's machine — only frame JPEGs / speech WAVs / cut proxies upload for AI. User-visible name is **Noey Studio** (renamed from Noey Video Edit 2026-09-22); `appId`, package `name` (installer filename in `routers/releases.py`) and the packaged userData folder (`Noey Video Edit`, pinned in `main/index.ts`) keep the old identifiers on purpose so updates keep users' projects and login. Packaging: PyInstaller sidecar + bundled ffmpeg + electron-builder NSIS (`npm run build:win` — bumps version, builds, and **uploads a public release**).
- **`web/`** — browser build of the SAME editor. `web/src` is a copy of the desktop renderer (`desktop/app/src/renderer/src`), built with the same `@renderer` alias and plugins (`vite.config.ts` mirrors `electron.vite.config.ts`) so copied UI compiles unchanged. What differs is underneath: `src/platform/noey-web.ts` provides `window.noey` (the desktop preload API) — its type is `typeof noey`, so a UI call the web shim lacks fails to compile; project files live in OPFS (`platform/fs.ts`, `opfsWrite*.ts`) and a service worker serves `/media/<uid>/<rel>` (mirrors desktop `media://`); `src/engine/` replaces the Python sidecar with WebCodecs jobs (mediabunny) in `engine/jobs/*` behind the same `sidecar.*` contract (progress filtered by `projectDir`, promise resolves with the last event, per-project serialisation). `platform/capability.ts` gates the app on a real test encode. `VITE_BACKEND_URL` sets both API URL and CSP origin. `web/PROGRESS.md` = port gate status. A UI change on one client usually needs the matching copy on the other — otherwise log it in `PARITY.md` (rule 8).
- **`admin/`** — owner-only admin dashboard (Next.js 16, `create-next-app`, BFF: the browser never sees the API; port 3001; Docker `admin` service). Built from the design `Admin Dashboard.dc.html`. Every baht is computed in ONE place, `src/lib/money.ts` (tested), from the usage FACTS the backend returns; `src/proxy.ts` sets a per-request nonce CSP and refreshes the session; Server Actions in `src/app/actions.ts` re-check Origin + session. Backend side: `routers/admin.py` behind the single guard `services/api/admin_deps.py:current_admin` (admin JWT audience `noey-admin` + server-side `admin_sessions` row re-read per request: is_admin, is_active, token_version, 30-min idle), login = password → emailed 6-digit code (`packages/admin/auth.py`), audit log `core.admin_audit_events`, cost assumptions `packages/admin/cost_config.py`, usage aggregates `packages/admin/metrics.py`, plan price edits `packages/admin/pricing.py` (Stripe: new Price + lookup-key transfer; no Stripe: `plan_price_overrides` served by GET /billing/plans) then noey-frontend `POST /api/revalidate-prices`. `tests/test_admin_security.py` walks app.routes — every new `/admin` route is denial-tested automatically. Local demo data: `backend/scripts/seed_admin_demo.py` (localhost DB only).
- **Local-render backend surface** (additive): `routers/videos_local.py` — `POST /videos/local`, `POST /videos/{uid}/analyze-frames`, `POST /videos/{uid}/analyze-video`, `POST /videos/{uid}/plan-dub`, `POST /videos/{uid}/transcribe-audio`, `POST /videos/{uid}/reedit-dub-scenes`, `POST /videos/{uid}/plan-effects`, `GET/PUT /videos/{uid}/effects`, `POST/DELETE /videos/{uid}/music`, `GET/PUT /videos/{uid}/local-timeline`, `PATCH /videos/{uid}/local-status`, `PUT /videos/{uid}/local-edit-script`; arq tasks `analyze_dub_local`, `analyze_dub_video_local`, `plan_talking_local`, `reedit_dub_scenes_local`, `plan_effects_local`, `distill_style_local`; `video_projects.origin/local_meta` columns. Shared cores extracted from worker tasks into `packages/video/`: `dub_ai.py` (dub prompts + LLM calls), `dub_render.py` (dub ffmpeg cores), `plan_core.py` (talking_head planning incl. Haiku passes), `elevenlabs_stt.py` (Scribe transport + transcript assembly), `speech_select.py` (speech-mode selection), `audio_extract.py` (speech WAV chain), `render_common.py` (SRT + CapCut bundle) — worker and sidecar/API both use them; do not fork their behavior.
- **The UI never names an AI vendor** — no Gemini, Twelve Labs, ElevenLabs or Claude in anything a user reads (an env-var name in a settings hint leaks it too). Code, comments and `.env` keep the real names.
- **Plan features & plan switch** (website = source of truth, noey-frontend `lib/plans.ts`): per-plan footage /
  project count / music / server transcode / queue priority live in `packages/billing/limits.py` and are enforced by
  `packages/billing/plan_features.py` (project creation, every footage start route, `/music`, `/transcode`, arq score
  lead); the editor's plan change is `packages/billing/plan_switch.py` (`POST /billing/plan-preview`,
  `POST /billing/plan-switch`, consent checked server-side). Editor UI per `docs/design/editor-limits.md`.
- **Video modes** (`video_projects.mode`, allow-list in `videos_local.py`): `talking_head`, `dub_first`, `highlight`, `speech_highlights` (long clip → N clips), `speech_scenes` (keep original audio, pick strong scenes). Statuses in `models/video_project.py`; `waiting_vo` is terminal for a dub run, and `paused_quota` is a run the plan's quota ran out on — the work is intact and it is the one status that must always be restartable.

## Effects Layer (AI-placed camera motion on top of the cut)

**Reduced to ffmpeg-only on 2026-08-12.** The Remotion half — the node-sidecar,
the whole overlay component library (including the components cloned from MIT
community projects), AI code-generation of new components, stickers, image
assets, popups and SFX — was removed. Anything an overlay used to draw on top of
the video is gone; only motion applied to the real footage remains. The removed
source is parked in `desktop/_removed/` (kept as a parking spot even though the repo is in git). `REMOTION_EFFECTS_REQUIREMENTS.md` and `EFFECTS_USER_GUIDE.md`
describe the OLD system and are historical only.

A stage that runs **after** the cut is rendered. It never touches the cut files —
`edit_script.json` / `timeline.json` decide *which footage plays when*; a sibling
`effects.json` (schema in `packages/video/effects.py`) decides *how the footage is
transformed*. Keep that split.

Every instance is `kind="transform"`: an ffmpeg filter chain over the real
footage. The three implementations + `TRANSFORM_REGISTRY` live in
`packages/video/transforms.py` — **punch-zoom** (ramp or hard `cut` entry, with
an optional hold-drift), **whip-pan** (a sweep straddling a real cut), and
**scene-drift** (a continuous ease across one whole scene). Adding a transform
means adding it there and describing it in the `<capabilities>`/`<zoom>` prose of
`effects_ai.py` — there is no separate catalog file any more.

`effects_render.py` applies everything in a **single ffmpeg pass** (one
filter_complex), not one re-encode per effect. `punch-zoom` is the one exception:
it is baked onto each per-scene clip pre-concat so its window cannot drift
against the real cut boundaries.

`effects_ai.py` (Gemini, own prompt/schema/model setting) outputs exactly three
arrays — `zoomPunches` / `transitions` / `sceneDrifts` — and nothing else. That
restriction is enforced by `EFFECTS_PLACEMENT_SCHEMA` rather than by prose: a
field the model *can* fill eventually gets filled. `transitions`/`sceneDrifts`
are only offered when the caller passes real cut timestamps.

Burned-in captions are a **different stage** and are unaffected:
`packages/video/caption.py` writes an ASS subtitle file that ffmpeg burns in.

Surface: `POST /videos/{uid}/plan-effects` (upload cut proxy + optional steering
prompt + script + cuts + optional style reference → arq `plan_effects_local`),
`GET/PUT /videos/{uid}/effects` — both in `routers/videos_local.py`.

**Effect Styles** (reusable per-user AI editing style, distilled once, reused on
every placement run): `packages/db/models/effect_style.py` (`EffectStyle`,
per-tenant, status pending/ready/error), `packages/video/effects_style.py`
(checklist-driven Gemini distillation of a reference clip and/or text description
→ stored prose; three motion axes only, and an axis the model did not answer is
OMITTED rather than defaulted — a fabricated cadence reads exactly like an
observed one and the placement prompt obeys the style), arq `distill_style_local`
(`services/worker/tasks.py`), CRUD in `routers/effect_styles.py`
(`/effect-styles`). The stored prose is spliced into `EFFECTS_PLACEMENT_SYSTEM`
(`effects_ai.py`, `__STYLE_BLOCK__` token) on every later placement run instead of
re-uploading the reference video each time. `packages/video/cut_style.py` reuses
`effects_style`'s `_band`/`_CADENCE` helpers for the separate CUT-style
distillation — it wants a documented default per axis, so it wraps them in its
own `_band_or`.

**Desktop UI migration is DONE** — the `@fx` alias, the node-sidecar, `main/library.ts`,
`lib/effectsPipeline.ts` and the `remotion` deps are gone; `desktop/app` builds against the
ffmpeg-only layer. `lib/effectsCatalog.ts` survives as the *transform* prop catalog used by
`EffectsCanvasEditor.tsx`.

**Not built yet**: no `services/scraper`. Live scraping is remaining work; current data path is CSV import via the API. Desktop app: auto-update, code signing, macOS build (needs a Mac).

**Video pipeline deps**: ffmpeg must be available. Set `FFMPEG_PATH=C:\path\to\ffmpeg.exe` in `.env`, or install via `winget install Gyan.FFmpeg`. The worker auto-discovers it from `LOCALAPPDATA/Microsoft/WinGet` on Windows.
Uploaded clips land in `backend/data/video_uploads/<project_uid>/`; rendered output in `backend/data/video_outputs/<project_uid>/`.

**Optional S3/R2 storage**: set `S3_BUCKET` (+ `S3_ENDPOINT_URL` for Cloudflare R2) to sync video files between API and worker hosts. When unset, all `packages/video/s3.py` methods are no-ops and the local filesystem is sole storage.

**`loadtest/`** — capacity testing WITHOUT paying a vendor: `LOADTEST_FAKE_AI=1`
makes `packages/llm/fake.py` answer every model call, Files-API upload and
speech-to-text request with a canned, parseable result after a realistic delay
(everything else — run rows, per-request charging, guard, vendor slots, metering,
queue, DB, Redis, S3 — stays real). Settings REFUSE to load it when the environment says
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

Skill files live in `.claude/skills/<name>/`.


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

Backend tests live in `backend/tests/` (~40 files); most video work is covered by a
`test_<module>.py` next to the module it exercises — add there rather than starting a
new suite.

**Web**
```bash
cd web && npx vite --port 5174   # dev server
cd web && npm run build          # typecheck + production build
cd web && npm run typecheck      # tsc only
cd web && npm run lint           # ESLint
cd web && npx vitest run         # Vitest unit tests
cd web && npx vitest run src/lib/shotSwap.test.ts   # single file
```

**Desktop app** (from `desktop/app` unless noted)
```bash
npm run dev                     # Electron dev with HMR
npm run test                    # Vitest
npm run typecheck && npm run lint
npm run build                   # production bundles
cd desktop/sidecar && python -m pytest tests/   # sidecar tests (same Python env as backend)
npm run build:win               # bumps version, builds NSIS, UPLOADS a public release — never run casually
```

`npm run build:win` is a **publish**, not a build check. Use `npm run build` /
`build:unpack` to verify a build; only run `build:win` when the user asks to ship.

**Infrastructure**
```bash
docker compose up -d postgres   # start only postgres
docker compose up -d redis      # start only redis (required for arq worker)
docker compose up -d            # start all containers
```

## Docs

- `docs/ai-video-editing.md` — the video pipeline end to end.
- `docs/railway-deploy.md` — deploy notes (API + worker on separate hosts → this is why `s3.py` exists).
- `AGENTS.md` — a Codex-facing mirror of this file. Update both together, or say which one is authoritative.
- Historical only (describe removed systems): `REMOTION_EFFECTS_REQUIREMENTS.md`, `EFFECTS_USER_GUIDE.md`.

## Reply language

Converse with the user in **Thai**. All persisted artifacts (code, docs, skills) in
**English**.
