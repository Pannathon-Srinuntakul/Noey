---
name: backend-api
description: FastAPI service structure and conventions for services/api (REST metrics/filters, chatbot endpoint, prompt-cron CRUD). Load before writing or changing backend API code.
---

# Backend API Skill — FastAPI, typed, async

Scope: `backend/services/api`. Python 3.12, FastAPI, async, Pydantic at every boundary.

## Structure

```
backend/services/api/
  main.py            # FastAPI app factory, router includes, middleware, lifespan
  deps.py            # shared deps (DB session, settings, llm gateway)
  routers/
    metrics.py       # GET overview (GMV/commission/units), time-series
    products.py      # per-product list + filters
    creators.py      # per-creator breakdown
    market.py        # market-trend views
    chat.py          # POST chatbot (LLM gateway + DB tools, streaming response)
    prompt_cron.py   # CRUD for ai_prompts (+ register/unregister scheduler jobs)
    runs.py          # ai_runs history
  schemas/           # Pydantic request/response models
  services/          # business logic (query builders, chat orchestration)
```

## Conventions

- **Routers thin, logic in `services/`.** Routers parse/validate and delegate.
- **Pydantic schemas** for all request/response bodies — no raw dicts across the boundary.
- **Async DB access** via `packages/db` session dependency; parameterized queries only
  (the chatbot's DB tools must never interpolate user text into SQL).
- **AI only via `packages/llm`** gateway — never import a vendor SDK here.
- **Chatbot endpoint** runs a tool-calling loop: expose read-only DB-query tools
  (`query_sales`, `query_products`, `query_creators`, `query_market_trends`) that run
  vetted parameterized SQL; stream the model's answer back.
- **Prompt-cron CRUD** writes `ai_prompts` and registers/updates an APScheduler job via
  the scheduler service's API/shared jobstore; schedule is clamped to the cadence floor
  for any scrape-like cadence (`packages/core/cadence.py`).
- **Errors**: typed HTTP exceptions, consistent error envelope, request IDs in logs.
- **Auto OpenAPI docs** kept meaningful (summaries, response models).
- **Tests**: pytest + httpx AsyncClient; mock the llm gateway and DB where needed.
