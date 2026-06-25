# Architecture — Service & Package Split

Professional monorepo: **deployable services** in `services/`, **shared libraries** in
`packages/`. Each service is independently runnable and containerized; packages are
imported by services and never run on their own.

Top-level split: **`backend/` = all Python, `frontend/` = all TypeScript/React.** The
repo root holds only shared/ops files.

```
Noey Tiktok/
├── CLAUDE.md                 # project rules (incl. NO GIT)
├── PROJECT_REQUIREMENTS.md   # spec
├── ARCHITECTURE.md           # this file
├── docker-compose.yml        # postgres (+ api/scheduler/web containers later)
├── .env / .env.example       # single-source config (root; not committed / no git)
├── .claude/skills/           # project skills
│
├── backend/                  # ALL Python (run tooling from here)
│   ├── pyproject.toml  alembic.ini  .venv/
│   ├── tests/
│   ├── packages/             # shared libraries (not deployable)
│   │   ├── core/             # settings (Pydantic Settings), logging, cadence safety floor
│   │   ├── db/               # SQLAlchemy models, session, Alembic migrations
│   │   └── llm/              # provider-agnostic LiteLLM gateway (cloud + local)
│   └── services/             # deployable units
│       ├── scraper/          # Playwright workers (own dashboard + market trend)
│       ├── api/              # FastAPI: REST metrics/filters + chatbot endpoint
│       └── scheduler/        # APScheduler: scrape jobs + user prompt-cron jobs
│
└── frontend/                 # ALL TypeScript — React + Vite + R3F (3D data world)
    ├── package.json
    └── src/
```

Backend Settings reads the root `.env` via `(".env", "../.env")`, so it resolves whether
invoked from the repo root or from `backend/`.

## Service responsibilities

| Service | Responsibility | Depends on |
|---|---|---|
| `backend/services/scraper` | Login (+OTP), session persist, deterministic extraction of own data and external market trend. No AI. | `packages/{core,db}` |
| `backend/services/api` | REST (metrics, per-product/creator filters, market views) + chatbot (LLM + DB tools, streaming) + prompt-cron CRUD. | `packages/{core,db,llm}` |
| `backend/services/scheduler` | Runs scrape jobs and user prompt-cron jobs on cadence (clamped to the safety floor); writes `ai_runs`. | `packages/{core,db,llm}` + scraper |
| `frontend/` | 3D-data-world dashboard, 2D HUD overlays, chat panel, prompt-cron manager, 2D-table fallback. | `backend/services/api` (HTTP) |

## Shared packages

| Package | Contents |
|---|---|
| `packages/core` | `Settings` (env config), structured logging, **`cadence.py`** — the single source of the scrape-frequency floor + jitter, used by both scheduler and "run now". |
| `packages/db` | SQLAlchemy models (`products`, `creators`, `sales_daily`, `market_trends`, `ai_prompts`, `ai_runs`, `scrape_runs`), session factory, Alembic env + versions. Idempotent upserts. |
| `packages/llm` | `gateway.py` — `chat()` / `complete()` over LiteLLM; tool-calling normalized; graceful no-tools degrade. The only place that talks to any model. |

## Process / deployment model

- **postgres** — Docker container, holds all data + APScheduler jobstore.
- **api** — FastAPI (uvicorn) container.
- **scheduler** — separate process/container so a stuck scrape never blocks the API.
- **web** — Vite dev server (dev) / static build behind the API or a static host (prod).

Keeping `scheduler` separate from `api` is deliberate: scraping is slow and can hang on
captcha/OTP; isolating it protects API responsiveness.

## Data flow

```
scraper ──writes──► postgres ◄──reads── api ──serves──► web
   ▲                   ▲                   │
   └── scheduler fires ┘                   ├─ chatbot: llm gateway + DB-query tools
       (cadence-clamped)                   └─ prompt-cron: llm gateway ──► ai_runs ──► web
```
