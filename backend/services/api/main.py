"""FastAPI application factory for Noey Tiktok."""

import pathlib
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from packages.core.logging import configure_logging, get_logger
from packages.core.settings import get_settings
from services.api.routers import (
    analytics,
    auth,
    chat,
    creators,
    workspace,
    custom_tables,
    import_csv,
    jobs,
    market,
    metrics,
    products,
    prompt_cron,
    runs,
    settings,
    table_io,
    videos,
)

log = get_logger(__name__)


def _alembic_upgrade() -> None:
    from alembic import command
    from alembic.config import Config
    ini = pathlib.Path(__file__).parent.parent.parent / "alembic.ini"
    log.info("alembic_upgrade_start")
    command.upgrade(Config(str(ini)), "head")
    log.info("alembic_upgrade_done")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    from scripts.migrate_to_multitenant import main as _seed
    log.info("seed_start")
    await _seed()
    log.info("seed_done")
    yield


def create_app() -> FastAPI:
    configure_logging()
    _alembic_upgrade()

    settings = get_settings()
    app = FastAPI(title="Noey Tiktok API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_url],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok"}

    for r in (
        auth,
        workspace,
        analytics,
        import_csv,
        metrics,
        products,
        creators,
        market,
        prompt_cron,
        runs,
        chat,
        settings,
        custom_tables,
        table_io,
        videos,
        jobs,
    ):
        app.include_router(r.router)

    return app


app = create_app()
