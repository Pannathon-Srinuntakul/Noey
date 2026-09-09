# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Noey Tiktok — Project Rules & Architecture

Personal analytics system for a TikTok **affiliate creator**: scrape the owner's **own**
TikTok back-office data (Playwright), store in PostgreSQL, expose a 3D-data-world
dashboard with provider-agnostic AI (analysis, chatbot, prompt-cron). See
`PROJECT_REQUIREMENTS.md` for the full spec and `ARCHITECTURE.md` for the service map.

## Hard Rules (non-negotiable)

1. **NEVER touch git.** Do not run any `git` command — no `init`, `add`, `commit`,
   `branch`, `push`, `status`, nothing. Do not create `.git`, `.gitignore`, or any
   git config. This repo is intentionally not under version control. If version
   control is ever wanted, the user will set it up themselves.
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

- **Backend (all of it): Python 3.12** — scraper, API, worker.
- **Frontend: TypeScript + React (Vite).**
- Postgres + SQLAlchemy + Alembic; FastAPI; arq + Redis (background jobs); LiteLLM; React Three Fiber.

## Conventions

- Monorepo split: **`backend/` = all Python, `frontend/` = all TypeScript/React.**
  Inside `backend/`: shared libs in `packages/`, deployable units in `services/`.
  Run all Python tooling (pytest, alembic, uvicorn) from `backend/`.
- Python: Ruff + mypy, type hints everywhere, Pydantic models at boundaries.
- TS: ESLint + Prettier, strict mode.
- Tests: pytest (backend), Vitest + Playwright (frontend).
- Structured JSON logging; every scrape/AI run recorded in audit tables.

## DB Schema Architecture

Two-layer schema design in PostgreSQL:

- **`core` schema** — auth + platform: `users`, `tenants`, `memberships`, `jobs` (arq job status).
- **`tenant_<slug>` schema** — per-tenant business data: analytics tables (CSV-imported), `custom_table_meta` registry, and all user-defined tables (`udt_*`).

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
    - `models/video_project.py` — VideoProject (per-tenant; statuses incl. pending/processing/waiting_vo/done/error/cancelled; modes: see "Video modes" below).
    - `models/effect_style.py` — EffectStyle (per-tenant; `kind` = effects style or cut style; status pending/ready/error).
    - `models/llm_usage.py` — per-user token usage + cost tracking.
    - `models/app_setting.py` — key-value app settings (per-tenant).
    - `models/scrape_run.py` — scrape run audit log.
  - `llm/` — LiteLLM gateway (`gateway.py`: `acompletion`, `acompletion_stream_thinking` for streamed extended-thinking, `complete`, `chat_once` — with retry/timeout/error-phase classification), `config.py` (`sync_llm_env`, `model_params`, `call_kwargs`, `vision_call_kwargs`, `anthropic_file_kwargs`, `model_supports_effort`), `files.py` (Anthropic Files API upload/delete for vision frames — via LiteLLM, never the `anthropic` SDK), `tools.py`, `usage.py` (per-user token tracking via ContextVar — set `UsageCtx` before any LLM call). **Only AI entry point.**
  - `tables/` — `formula.py` (compile formula spec → safe PostgreSQL GENERATED ALWAYS AS expression), `workspace.py` (provision 5 default TikTok Affiliate tables for new tenants).
  - `video/` — `storage.py` (file paths under `backend/data/`), `ffmpeg_bin.py` (ffmpeg/ffprobe wrapper, reads `FFMPEG_PATH`), `timeline.py` (transcript → cut list, AI highlight planning), `scene.py` (frame extraction for dub_first), `elevenlabs_stt.py` (**the only speech-to-text path** — ElevenLabs Scribe client + the word-gap arithmetic that decides the silence cut), `stt_pricing.py` (Scribe cost → usage rows), `speech_select.py` (speech modes: `select_highlights` = mode A long clip → N clips, `select_scenes` = mode B pick segments), `audio_edges.py` (cut-boundary snapping), `beat_analysis.py` (librosa beat grid for background music), `caption.py` (ASS subtitle generation), `face_tracker.py` (face bbox tracking), `fonts.py` (bundled Thai-capable caption fonts in `backend/data/fonts/`), `s3.py` (S3/R2 sync for multi-host deployments — no-op when `S3_BUCKET` unset).
    - Effects layer (see "Effects Layer" below): `effects.py`, `effects_ai.py`, `effects_render.py`, `transforms.py`.
    - Dub cut prompts are **versioned**: `dub_ai.py` dispatches to `dub_ai_v1.py` (rollback) or `dub_ai_v2.py` (current, span/ranking/continuity) via `DUB_PROMPT_VERSION`. Change a prompt in the versioned file, never by forking the dispatcher.
    - **Shot swap alternates (R18b)**: v2 edit-script segments carry `alternates` (≤3 backup shots + one-line Thai `note`, returned inside the SAME analysis call — never an extra model call). The field is REQUIRED in the Gemini response schema with empty = none (enforced decoding never fills an optional field — measured live 2026-09-01, 0/12 twice), restated in the v2 instruction tail, and validated in code by `timeline.py:sanitize_segment_alternates` (per-clip bounds silent-drop, >50% overlap with the main window drop, cap 3, NO minimum length at plan time — the length rule belongs to the desktop's locked regime). Empty arrays are stripped, so stored scripts still omit the field when there are no backups.
- **`backend/services/api/`** — FastAPI app. Routers: `auth`, `workspace`, `analytics`, `import_csv`, `metrics`, `products`, `creators`, `market`, `prompt_cron`, `runs`, `chat`, `settings`, `custom_tables`, `table_io`, `jobs`, `videos`, `videos_local`, `effect_styles`, `usage`, `releases` (unauthenticated presigned-S3 redirect for the desktop installer). Logic split: `queries.py` (read), `csv_importer.py`, `chat_service.py`, `schemas.py`, `deps.py` (DI + JWT extraction + search_path injection).
- **`backend/services/worker/`** — arq background worker (queue `arq:default`). Tasks: `csv_export`, `csv_import`, `ai_process`, the server-render video chain (`ingest_video`, `transcribe_video`, `plan_edit`, `render_video`, `analyze_dub_first`, `render_dub_silent`, `plan_dub_timeline`) and the desktop/local chain (`analyze_dub_local`, `analyze_dub_video_local`, `plan_talking_local`, `reedit_dub_scenes_local`, `plan_effects_local`, `distill_style_local`). API enqueues → returns `job_id` → frontend polls `GET /jobs/{job_id}`. Run: `python -m services.worker`.
- **`backend/scripts/`** — one-off operational/smoke scripts (NOT pytest): `check_project.py` (inspect a video_project row), `probe_stream_thinking.py` (verify streamed thinking chunks), `vision_smoke_test.py` (Files API vs base64 vision latency), `probe_elevenlabs.py` (Scribe on a real Thai clip → token shape, gap distribution, logprob spread, wall clock). Run from `backend/` with `python scripts/<name>.py`.
- **`backend/packages/db/alembic/`** — migrations live here (not `backend/alembic`); `alembic.ini` at `backend/` points `script_location` to it. Run alembic from `backend/`.
- **`frontend/src/`** — `auth/` (AuthContext, RequireAuth), `pages/` (Login, Island, Revenue, Catalog, Market, Import, Settings, TablePage, CreateTablePage, ManageFieldsPage, VideoPage), `scene/` (R3F: IslandWorld, DataWorld, InteractiveRoom, SphereField, DrillCard), `hud/` (TableEditor, AddColumnModal, ColumnSettingsPopover, ColumnFilterPopover, ConfirmModal, ImportModal, TemplateGallery, ChatPanel, Filters, MetricBar, PromptCron, RevenueOverlay, Room, RoomPage; `rooms/` sub-dir has per-route HUDs: CatalogRoom, ImportRoom, MarketRoom, SettingsRoom), `fallback/TableView.tsx` (2D fallback when R3F not supported), `lib/` (columnTypes, encoding, optionColors, tablePresets), `navigation/NavigationContext.tsx`, `api.ts` (backend client), `errors.ts` (central parser turning FastAPI/worker/LiteLLM/Anthropic error payloads into user-facing Thai strings — use `readApiError`/`formatUserError` instead of showing raw messages; covered by `errors.test.ts`), `types.ts`.

- **`desktop/`** — standalone desktop app for the AI video-edit feature (see `DESKTOP_VIDEO_APP_REQUIREMENTS.md` + `desktop/README.md`). Isolated from `backend/`/`frontend/` — additive backend changes only. `desktop/app/` = Electron + React + TS (electron-vite, Tailwind v4): own JWT login against existing `/auth/*` (no session sharing), safeStorage token store, local project registry (`userData/projects/<uid>/project.json`), `media://` privileged protocol for local video preview, mode-aware wizard (`pages/WizardPage.tsx`), timeline editor (`TimelineRoute.tsx`), effects/cut Style studio (`EffectsStudioPage.tsx`), voiceover (`VoiceoverPage.tsx`), app-level job progress (`JobProgressPage.tsx`). Long AI work runs at app level (`main/remoteJobs.ts`, `lib/fxJobs`) so leaving a screen does not kill it. R18b shot swap: `components/projects/ShotSwapModal.tsx` + `lib/shotSwap.ts` (swap a shot for an AI-returned `alternates` backup, ประกอบใหม่ locally — zero AI calls per swap round; free length regime before the voiceover / locked after, where the alternate is trimmed to the original durationSec anchored on matchedFrameTime and the planned timeline is re-pointed mechanically instead of re-planned), entry button `ปรับช็อต` on `ProjectDetailPage`, revert via the R12 `previousRender` mechanism; clicking a tray thumb previews the window in the app's `VideoModal` (new additive `stopAtSec` prop pauses at the window's end). Taste log: `main/tasteLog.ts` appends `shot_swap`/`shot_swap_revert`/`recut_note` events to `userData/taste-log.jsonl` at COMMIT only — collection-only this round, never fed to any prompt (R19 distills later). Phone/LAN surface in `main/`: `lanReceive.ts` (รับจากมือถือ / ส่งไปมือถือ over LAN), `remoteAccess.ts` + `remotePage.ts` + `remoteApi.ts` (phone remote = a switch, QR is a single-use pairing ticket → HttpOnly device cookie), `apiProxy.ts`. `desktop/sidecar/` = Python render engine spawned by Electron main; imports `backend/packages/video` read-only via `sys.path` (`bootstrap.py`, `NOEY_BACKEND_DIR` override); JSON-lines protocol on stdout (`ping`/`probe`/`ingest`/`extract-proxy`/`proxy-one`/`render`/`render-silent`/`render-final`/`render-timeline`/`render-highlights`/`render-effects`/`render-ai-preview`/`extract-audio`/`mix-music`), logs on stderr; outputs are written atomically (`atomic.py`: staged `.part` + faststart) so a file that exists is complete. Video files stay on the user's machine — only frame JPEGs / speech WAVs / cut proxies upload for AI. Packaging: PyInstaller sidecar + bundled ffmpeg + electron-builder NSIS (`npm run build:win` — bumps version, builds, and **uploads a public release**).
- **Local-render backend surface** (additive): `routers/videos_local.py` — `POST /videos/local`, `POST /videos/{uid}/analyze-frames`, `POST /videos/{uid}/analyze-video`, `POST /videos/{uid}/plan-dub`, `POST /videos/{uid}/transcribe-audio`, `POST /videos/{uid}/reedit-dub-scenes`, `POST /videos/{uid}/plan-effects`, `GET/PUT /videos/{uid}/effects`, `POST/DELETE /videos/{uid}/music`, `GET/PUT /videos/{uid}/local-timeline`, `PATCH /videos/{uid}/local-status`, `PUT /videos/{uid}/local-edit-script`; arq tasks `analyze_dub_local`, `analyze_dub_video_local`, `plan_talking_local`, `reedit_dub_scenes_local`, `plan_effects_local`, `distill_style_local`; `video_projects.origin/local_meta` columns. Shared cores extracted from worker tasks into `packages/video/`: `dub_ai.py` (dub prompts + LLM calls), `dub_render.py` (dub ffmpeg cores), `plan_core.py` (talking_head planning incl. Haiku passes), `elevenlabs_stt.py` (Scribe transport + transcript assembly), `speech_select.py` (speech-mode selection), `audio_extract.py` (speech WAV chain), `render_common.py` (SRT + CapCut bundle) — worker and sidecar/API both use them; do not fork their behavior.
- **The UI never names an AI vendor** — no Gemini, Twelve Labs, ElevenLabs or Claude in anything a user reads (an env-var name in a settings hint leaks it too). Code, comments and `.env` keep the real names.
- **Video modes** (`video_projects.mode`, allow-list in `videos_local.py`): `talking_head`, `dub_first`, `highlight`, `speech_highlights` (long clip → N clips), `speech_scenes` (keep original audio, pick strong scenes). Statuses in `models/video_project.py`; `waiting_vo` is terminal for a dub run.

## Effects Layer (AI-placed camera motion on top of the cut)

**Reduced to ffmpeg-only on 2026-08-12.** The Remotion half — the node-sidecar,
the whole overlay component library (including the components cloned from MIT
community projects), AI code-generation of new components, stickers, image
assets, popups and SFX — was removed. Anything an overlay used to draw on top of
the video is gone; only motion applied to the real footage remains. The removed
source is parked in `desktop/_removed/` (this repo has no git, so nothing was
deleted outright). `REMOTION_EFFECTS_REQUIREMENTS.md` and `EFFECTS_USER_GUIDE.md`
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

**`docs_raw/`** — raw TikTok Affiliate API documentation (markdown); reference when building scraper or API integrations.

## Skills (load the matching one before working in that area)

Skill files live in `.claude/skills/<name>/`.


- `scraper` — Playwright scraping, safety floor, stealth, selectors, OTP/session.
- `backend-api` — FastAPI service structure and conventions.
- `llm-gateway` — provider-agnostic AI usage (cloud + local).
- `database` — SQLAlchemy models + Alembic migrations.
- `frontend-3d` — the 3D-data-world UI design language.

## Commands

All Python commands run from `backend/`. All frontend commands run from `frontend/`.

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

**Frontend**
```bash
cd frontend && npm run dev      # dev server (localhost:5173)
cd frontend && npm run build    # production build
cd frontend && npm run lint     # ESLint
cd frontend && npm run test     # Vitest unit tests
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
