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
    - `models/video_project.py` — VideoProject (per-tenant; statuses: pending/processing/done/error/cancelled; modes: talking_head/dub_first).
    - `models/llm_usage.py` — per-user token usage + cost tracking.
    - `models/app_setting.py` — key-value app settings (per-tenant).
    - `models/scrape_run.py` — scrape run audit log.
  - `llm/` — LiteLLM gateway (`gateway.py`: `acompletion`, `acompletion_stream_thinking` for streamed extended-thinking, `complete`, `chat_once` — with retry/timeout/error-phase classification), `config.py` (`sync_llm_env`, `model_params`, `call_kwargs`, `vision_call_kwargs`, `anthropic_file_kwargs`, `model_supports_effort`), `files.py` (Anthropic Files API upload/delete for vision frames — via LiteLLM, never the `anthropic` SDK), `tools.py`, `usage.py` (per-user token tracking via ContextVar — set `UsageCtx` before any LLM call). **Only AI entry point.**
  - `tables/` — `formula.py` (compile formula spec → safe PostgreSQL GENERATED ALWAYS AS expression), `workspace.py` (provision 5 default TikTok Affiliate tables for new tenants).
  - `video/` — `storage.py` (file paths under `backend/data/`), `ffmpeg_bin.py` (ffmpeg/ffprobe wrapper, reads `FFMPEG_PATH`), `timeline.py` (transcript → cut list, AI highlight planning), `scene.py` (frame extraction for dub_first), `transcribe.py` (Whisper wrapper), `caption.py` (ASS subtitle generation), `overlay.py` (visual effects/stickers render), `stickers.py` (sticker asset resolution), `face_tracker.py` (face bbox tracking), `style_profile.py` (PySceneDetect + Claude Vision → Style Profile JSON), `s3.py` (S3/R2 sync for multi-host deployments — no-op when `S3_BUCKET` unset).
- **`backend/services/api/`** — FastAPI app. Routers: `auth`, `workspace`, `analytics`, `import_csv`, `metrics`, `products`, `creators`, `market`, `prompt_cron`, `runs`, `chat`, `settings`, `custom_tables`, `table_io`, `jobs`, `videos`, `usage`. Logic split: `queries.py` (read), `csv_importer.py`, `chat_service.py`, `schemas.py`, `deps.py` (DI + JWT extraction + search_path injection).
- **`backend/services/worker/`** — arq background worker (queue `arq:default`). Tasks: `csv_export`, `csv_import`, `ai_process`, `ingest_video` (AI cut selection → ffmpeg render → CapCut ZIP). API enqueues → returns `job_id` → frontend polls `GET /jobs/{job_id}`. Run: `python -m services.worker`.
- **`backend/services/whisper/`** — separate arq worker (queue `arq:whisper`) for heavy Whisper transcription. Deploy as its own process/Railway service. Run: `python -m services.whisper`.
- **`backend/services/modal_whisper/`** — Modal.com cloud deployment of the Whisper task (GPU serverless); alternative to the local whisper worker.
- **`backend/scripts/`** — one-off operational/smoke scripts (NOT pytest): `check_project.py` (inspect a video_project row), `probe_stream_thinking.py` (verify streamed thinking chunks), `vision_smoke_test.py` (Files API vs base64 vision latency). Run from `backend/` with `python scripts/<name>.py`.
- **`backend/packages/db/alembic/`** — migrations live here (not `backend/alembic`); `alembic.ini` at `backend/` points `script_location` to it. Run alembic from `backend/`.
- **`frontend/src/`** — `auth/` (AuthContext, RequireAuth), `pages/` (Login, Island, Revenue, Catalog, Market, Import, Settings, TablePage, CreateTablePage, ManageFieldsPage, VideoPage), `scene/` (R3F: IslandWorld, DataWorld, InteractiveRoom, SphereField, DrillCard), `hud/` (TableEditor, AddColumnModal, ColumnSettingsPopover, ColumnFilterPopover, ConfirmModal, ImportModal, TemplateGallery, ChatPanel, Filters, MetricBar, PromptCron, RevenueOverlay, Room, RoomPage; `rooms/` sub-dir has per-route HUDs: CatalogRoom, ImportRoom, MarketRoom, SettingsRoom), `fallback/TableView.tsx` (2D fallback when R3F not supported), `lib/` (columnTypes, encoding, optionColors, tablePresets), `navigation/NavigationContext.tsx`, `api.ts` (backend client), `errors.ts` (central parser turning FastAPI/worker/LiteLLM/Anthropic error payloads into user-facing Thai strings — use `readApiError`/`formatUserError` instead of showing raw messages; covered by `errors.test.ts`), `types.ts`.

- **`desktop/`** — standalone desktop app for the AI video-edit feature, **both modes** (dub_first + talking_head) end-to-end (see `DESKTOP_VIDEO_APP_REQUIREMENTS.md` + `desktop/README.md`). Isolated from `backend/`/`frontend/` — additive backend changes only. `desktop/app/` = Electron + React + TS (electron-vite, Tailwind v4): own JWT login against existing `/auth/*` (no session sharing), safeStorage token store, local project registry (`userData/projects/<uid>/project.json`), `media://` privileged protocol for local video preview, mode-aware wizard (`DubWizard.tsx` — dub: analyze → silent → VO → final; talking_head: extract-audio → server transcribe+plan → local render), TimelineEditor ported from the web editor (IO seam in `lib/editorApi.ts`). `desktop/sidecar/` = Python render engine spawned by Electron main; imports `backend/packages/video` read-only via `sys.path` (`bootstrap.py`, `NOEY_BACKEND_DIR` override); JSON-lines protocol on stdout (`ping`/`probe`/`ingest`/`extract-frames`/`render-silent`/`render-final`/`extract-audio`/`render-timeline`), logs on stderr. Video files stay on the user's machine — only frame JPEGs (dub) / speech WAVs (talking_head) upload for AI. Packaging: PyInstaller sidecar + bundled ffmpeg + electron-builder NSIS/dmg (`npm run build:win`).
- **Local-render backend surface** (additive): `routers/videos_local.py` (`POST /videos/local`, `POST /videos/{uid}/analyze-frames`, `POST /videos/{uid}/plan-dub`, `POST /videos/{uid}/transcribe-audio`, `GET/PUT /videos/{uid}/local-timeline`, `PATCH /videos/{uid}/local-status`, `PUT /videos/{uid}/local-edit-script`), arq tasks `analyze_dub_local` + `plan_talking_local`, `video_projects.origin/local_meta` columns. Shared cores extracted from worker tasks into `packages/video/`: `dub_ai.py` (dub prompts + LLM calls), `dub_render.py` (dub ffmpeg cores), `plan_core.py` (talking_head planning incl. Haiku passes), `whisper_client.py` (Modal/local Whisper transport + post-processing), `audio_extract.py` (speech WAV chain), `render_common.py` (SRT + CapCut bundle) — worker and sidecar/API both use them; do not fork their behavior.

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

# Run Whisper-only worker (separate queue arq:whisper)
cd backend && python -m services.whisper

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
