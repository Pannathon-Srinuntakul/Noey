"""Whisper worker entry point — runs only the transcribe_video task.

Deploy this as a separate Railway service so the heavy Whisper model
is isolated from the main worker. Same Redis queue; arq routes
"transcribe_video" jobs here automatically.

Run:  python -m services.whisper
"""

from arq import run_worker
from arq.connections import RedisSettings

from packages.core.logging import configure_logging
from packages.core.settings import reload_settings
from services.worker.tasks import shutdown, startup, transcribe_video


class WhisperWorkerSettings:
    functions = [transcribe_video]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = "arq:whisper"
    max_jobs = 2
    job_timeout = 86_400 * 365
    keep_result = 3600


def main() -> None:
    configure_logging()
    settings = reload_settings()
    from packages.core.logging import get_logger
    log = get_logger(__name__)
    log.info("whisper_worker_startup", model=settings.whisper_model, device=settings.whisper_device)
    run_worker(WhisperWorkerSettings, redis_settings=RedisSettings.from_dsn(settings.redis_url))


if __name__ == "__main__":
    main()
