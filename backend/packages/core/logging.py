"""Structured JSON logging, shared across services."""

import logging

import structlog


def configure_logging(level: int = logging.INFO) -> None:
    structlog.configure(
        processors=[
            # FIRST, so what a request or job bound (`request_id`, `user_id` —
            # services/api/middleware.py; a worker task binding the id it was
            # enqueued with) lands on every line, and an explicit kwarg on a
            # log call still wins over the bound value.
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
