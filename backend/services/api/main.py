"""FastAPI application factory for Noey Tiktok."""

import asyncio
import contextlib
import pathlib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from packages.core.logging import configure_logging, get_logger
from packages.core.monitoring import init_monitoring
from packages.core.settings import (
    _ENV_FILES,
    announce_fake_ai,
    assert_production_secrets,
    get_settings,
)
from services.api.arq_pool import close_arq_pool, warm_arq_pool
from services.api.middleware import BodySizeLimitMiddleware, RequestContextMiddleware
from services.api.routers import (
    account,
    admin,
    admin_blog,
    auth,
    auth_google,
    auth_handoff,
    billing,
    blog,
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


def _alembic_config() -> Any:
    """The Config for running Alembic INSIDE this process.

    ``configure_logger=False`` tells env.py not to apply alembic.ini's logging:
    its ``fileConfig`` (default ``disable_existing_loggers=True``) disabled
    uvicorn's error and access loggers for the rest of the process's life —
    access logs and uvicorn's own "Exception in ASGI application" tracebacks
    were silently gone after every startup."""
    from alembic.config import Config

    ini = pathlib.Path(__file__).parent.parent.parent / "alembic.ini"
    cfg = Config(str(ini))
    cfg.attributes["configure_logger"] = False
    return cfg


def _alembic_upgrade() -> None:
    from alembic import command

    log.info("alembic_upgrade_start")
    command.upgrade(_alembic_config(), "head")
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
    # One arq pool for the life of the process (services/api/arq_pool.py) —
    # warmed here so the first enqueue does not pay the connect, closed on
    # shutdown so uvicorn's graceful stop is not held up by an open socket.
    app.state.arq_pool_ready = await warm_arq_pool()
    # The blog MCP server's session manager (services/mcp/server.py) — one per
    # process, serving /mcp until shutdown.
    from services.mcp import server as mcp_server

    try:
        async with mcp_server.run():
            yield
    finally:
        from packages.blog import revalidate

        await revalidate.drain()
        await close_arq_pool()


#: How long each readiness probe may take. Railway polls the health path every
#: few seconds and treats a slow answer as a failure, and a probe that waits
#: on a hung dependency would itself hide the outage it is meant to report.
_READY_TIMEOUT_SEC = 1.0


async def _db_ready() -> bool:
    """``SELECT 1`` on the lifeline (NullPool) engine.

    Deliberately not the request pool: a probe that queues behind a saturated
    pool reports "down" for a database that is fine, and — worse — takes a
    connection from a request that needed it. The lifeline opens its own.
    """
    from sqlalchemy import text

    from packages.db.session import get_lifeline_engine

    try:
        async with asyncio.timeout(_READY_TIMEOUT_SEC):
            async with get_lifeline_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 — any failure is "not ready"
        log.warning("ready_db_failed", error=str(exc)[:200])
        return False
    return True


async def _redis_ready() -> bool:
    """``PING`` the arq Redis (REDIS_URL) on a throwaway client.

    A fresh client per probe, not the shared arq pool: the pool may not exist
    yet (its warm-up is best effort) and a probe must never be the thing that
    first opens it. One connect per poll interval is nothing.
    """
    import redis.asyncio as aioredis

    client = aioredis.from_url(
        get_settings().redis_url,
        socket_timeout=_READY_TIMEOUT_SEC,
        socket_connect_timeout=_READY_TIMEOUT_SEC,
    )
    try:
        async with asyncio.timeout(_READY_TIMEOUT_SEC):
            return bool(await client.ping())
    except Exception as exc:  # noqa: BLE001
        log.warning("ready_redis_failed", error=str(exc)[:200])
        return False
    finally:
        # Closing a client whose connect already failed is not news.
        with contextlib.suppress(Exception):
            await client.aclose()


def create_app() -> FastAPI:
    configure_logging()
    # Before anything else, and before the port opens: a deployment running on
    # the placeholder JWT secret can have any account's token forged by anyone
    # who can read this repo. Refusing to boot is the only guard that cannot
    # itself be forgotten.
    assert_production_secrets()
    # Load-test fake AI: refuses to boot in production, warns loudly otherwise.
    announce_fake_ai()
    # Error monitoring: a no-op unless SENTRY_DSN is set (never under pytest or
    # fake AI). Before the app object exists so the ASGI integration wraps it.
    init_monitoring("api")

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

    # Added first = innermost of ours, so CORS and the request id still wrap
    # the 413 it sends. 5% over the largest per-file cap covers multipart
    # framing and the small parts (manifests, forms) that ride along with a clip.
    app.add_middleware(
        BodySizeLimitMiddleware, limit_bytes=int(get_settings().max_upload_bytes * 1.05)
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
        # X-Request-ID so a browser client can quote the id of a failed call.
        expose_headers=[
            "Content-Range",
            "Content-Length",
            "Accept-Ranges",
            "Retry-After",
            "X-Request-ID",
        ],
    )
    # Added AFTER CORS, which makes it the OUTER layer: `add_middleware` wraps
    # the app inside-out, so the last one added sees the request first and the
    # response last. Outer is what it has to be — CORS answers preflights
    # itself without calling further in, and those replies still need the
    # request id and the security headers. CORS's own headers are untouched
    # either way; only `http.response.start` headers are added to.
    app.add_middleware(RequestContextMiddleware)
    # Outermost of all: requests for the embed origin (blog visuals + fonts,
    # BLOG_EMBED_PUBLIC_URL) are answered here and never reach the API — no
    # route, cookie or header of the API applies to them (services/api/embed.py).
    from services.api.embed import EmbedHostMiddleware

    app.add_middleware(EmbedHostMiddleware)

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        """Liveness: the process is up and serving. Touches nothing."""
        return {"status": "ok"}

    @app.get("/health/ready", tags=["meta"])
    async def health_ready() -> JSONResponse:
        """Readiness: the dependencies this process needs to do real work.

        Railway's health-check path (docs/railway-deploy.md) — a deploy only
        takes traffic once it can reach both. 503 names which one failed so
        the dashboard says "redis" rather than "unhealthy".
        """
        db_ok, redis_ok = await asyncio.gather(_db_ready(), _redis_ready())
        body = {
            "status": "ok" if db_ok and redis_ok else "fail",
            "db": "ok" if db_ok else "fail",
            "redis": "ok" if redis_ok else "fail",
        }
        return JSONResponse(body, status_code=200 if db_ok and redis_ok else 503)

    for r in (
        admin,
        admin_blog,
        auth,
        auth_google,
        auth_handoff,
        account,
        billing,
        blog,
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

    # The blog MCP server + its OAuth endpoints (plain Starlette routes: /mcp,
    # /mcp/oauth/*, /.well-known/oauth-*). See docs/blog-mcp.md.
    from services.mcp import server as mcp_server

    app.router.routes.extend(mcp_server.routes())

    return app


app = create_app()
