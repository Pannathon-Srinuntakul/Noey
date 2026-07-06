"""Make ``backend/packages`` importable without touching the backend tree.

Resolution order for the backend directory:

1. ``NOEY_BACKEND_DIR`` environment variable (set by the Electron main process
   in packaged builds, where the backend code ships inside app resources).
2. Repo-relative ``../../backend`` (development checkout layout:
   ``<repo>/desktop/sidecar/sidecar/bootstrap.py`` → ``<repo>/backend``).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def find_backend_dir() -> Path:
    env = os.environ.get("NOEY_BACKEND_DIR")
    if env:
        p = Path(env)
        if (p / "packages").is_dir():
            return p.resolve()
        raise FileNotFoundError(f"NOEY_BACKEND_DIR has no packages/ dir: {env}")

    repo_backend = Path(__file__).resolve().parents[3] / "backend"
    if (repo_backend / "packages").is_dir():
        return repo_backend

    raise FileNotFoundError(
        "backend directory not found — set NOEY_BACKEND_DIR to the directory "
        "containing packages/ (the backend checkout or bundled resources)"
    )


def ensure_backend_on_path() -> Path:
    """Idempotently prepend the backend dir to sys.path; return it."""
    backend = find_backend_dir()
    entry = str(backend)
    if entry not in sys.path:
        sys.path.insert(0, entry)
    return backend


def configure_stderr_logging() -> None:
    """Route backend structlog output to stderr.

    stdout is reserved for the JSON-lines protocol the Electron main process
    parses; any log line on stdout would corrupt it.
    """
    import logging

    import structlog

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=False,
    )
