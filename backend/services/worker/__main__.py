"""arq worker entry point.

Run:  python -m services.worker
Docker: command: ["python", "-m", "services.worker"]

Workers consume jobs enqueued via arq.create_pool().  Each job function receives
a WorkerContext (ctx) that holds a shared async DB sessionmaker and the arq pool itself.
"""


from arq import run_worker
from arq.connections import RedisSettings

from packages.core.logging import configure_logging
from packages.core.settings import get_settings, reload_settings
from services.worker.tasks import WorkerSettings


def main() -> None:
    configure_logging()
    settings = reload_settings()
    from packages.core.logging import get_logger
    log = get_logger(__name__)
    log.info(
        "worker_startup",
        llm_model=settings.llm_model,
        anthropic_key_set=bool(settings.anthropic_api_key),
    )
    # Parse redis://host:port/db
    url = settings.redis_url
    # arq RedisSettings from URL
    run_worker(WorkerSettings, redis_settings=RedisSettings.from_dsn(url))


if __name__ == "__main__":
    main()
