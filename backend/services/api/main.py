"""FastAPI application factory for Noey Tiktok."""

import pathlib
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from packages.core.logging import configure_logging, get_logger
from packages.core.settings import (
    _ENV_FILES,
    announce_fake_ai,
    assert_production_secrets,
    get_settings,
)
from services.api.routers import (
    admin,
    auth,
    billing,
    contact,
    effect_styles,
    jobs,
    releases,
    transfer,
    usage,
    videos,
    videos_local,
    wallet,
)

log = get_logger(__name__)


def _alembic_upgrade() -> None:
    from alembic import command
    from alembic.config import Config
    ini = pathlib.Path(__file__).parent.parent.parent / "alembic.ini"
    log.info("alembic_upgrade_start")
    command.upgrade(Config(str(ini)), "head")
    log.info("alembic_upgrade_done")


#: Any constant, as long as nothing else in the database picks the same one.
#: `pg_advisory_lock` keys are a single global namespace per database.
_STARTUP_LOCK_KEY = 8_713_204_119_470_003


@asynccontextmanager
async def _startup_lock() -> AsyncGenerator[None, None]:
    """Hold a database-wide lock for the duration of migrate + seed.

    The API runs with several uvicorn workers (API_WORKERS) and Railway may run
    several replicas, so this block starts in N processes at once. Without a
    lock they would run `alembic upgrade head` and the seed concurrently against
    one database: duplicate DDL, a racing `alembic_version` update, and inserts
    that each think they are first. A session-level advisory lock serialises
    them — the first process migrates, the rest wait and then find nothing to do.

    Taken on its own connection (NullPool), so waiting here never occupies a
    connection the request pool needs.
    """
    from sqlalchemy import text

    from packages.db.session import get_lifeline_engine

    engine = get_lifeline_engine()
    conn = await engine.connect()
    try:
        await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _STARTUP_LOCK_KEY})
        yield
    finally:
        try:
            await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _STARTUP_LOCK_KEY})
        finally:
            await conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Schema + seed, at STARTUP rather than at import.

    Both used to run inside `create_app()`, which every `import
    services.api.main` executes — a test collection, a `--help`, an inspection
    script. Migrating and seeding a database as a side effect of importing a
    module is a surprise nobody wants twice; here they run once, when the
    process actually starts serving.
    """
    from scripts.migrate_to_multitenant import main as _seed

    async with _startup_lock():
        _alembic_upgrade()
        log.info("seed_start")
        await _seed()
        log.info("seed_done")
    yield


def create_app() -> FastAPI:
    configure_logging()
    # Before anything else, and before the port opens: a deployment running on
    # the placeholder JWT secret can have any account's token forged by anyone
    # who can read this repo. Refusing to boot is the only guard that cannot
    # itself be forgotten.
    assert_production_secrets()
    # Load-test fake AI: refuses to boot in production, warns loudly otherwise.
    announce_fake_ai()

    cfg = get_settings()
    # Which .env files were actually read — both the repo root and backend/ are
    # loaded, and the LAST one wins. Neither is in the container image, so on a
    # real deployment this logs an empty list and every value came from the
    # process environment. Worth saying out loud: "why is my value ignored?" is
    # otherwise a silent override.
    log.info("settings_env_files", files=list(_ENV_FILES))

    # `/docs`, `/redoc` and `/openapi.json` are OFF unless a deployment opts in.
    # The schema lists every route with its docstring, and the docstrings name
    # the providers behind the AI features.
    app = FastAPI(
        title="Noey Tiktok API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if cfg.api_docs_enabled else None,
        redoc_url="/redoc" if cfg.api_docs_enabled else None,
        openapi_url="/openapi.json" if cfg.api_docs_enabled else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        # Range-response headers are NOT CORS-safelisted, so a cross-origin
        # reader cannot see them unless they are named here. The web build's
        # service worker forwards a `<video>` Range request to this API and
        # hands the reply back to the player: without `Content-Range` the
        # player has no idea what it received and refuses to load the file at
        # all (measured 2026-09-08 — a clean 206 whose Content-Range was
        # invisible, and a video that would not start).
        # Retry-After rides on every 429 from the rate limiter
        # (services/api/ratelimit.py); without it here a browser cannot read it.
        expose_headers=["Content-Range", "Content-Length", "Accept-Ranges", "Retry-After"],
    )

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok"}

    for r in (
        admin,
        auth,
        billing,
        contact,
        effect_styles,
        jobs,
        releases,
        usage,
        wallet,
        # `/videos/transfer/...` is all literal paths — before the two below
        # because `videos` owns GET /videos/{uid}, and FastAPI matches in
        # registration order.
        transfer,
        videos_local,
        videos,
    ):
        app.include_router(r.router)

    return app


app = create_app()
