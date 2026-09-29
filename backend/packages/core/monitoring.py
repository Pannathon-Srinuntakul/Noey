"""Error monitoring with Sentry — OFF unless SENTRY_DSN is set.

Written against Sentry's current Python documentation (fetched 2026-09-30):
  https://docs.sentry.io/platforms/python/integrations/fastapi/
  https://docs.sentry.io/platforms/python/integrations/arq/
  https://docs.sentry.io/platforms/python/configuration/options/
  https://docs.sentry.io/platforms/python/configuration/filtering/
  https://docs.sentry.io/platforms/python/data-management/sensitive-data/

``init_monitoring(service)`` is called once per process: by the API factory
(services/api/main.py) and the arq worker's entry point
(services/worker/__main__.py). FastAPI/Starlette and arq integrations are
auto-enabled by the SDK when those packages are importable.

Privacy (the owner's customers' data never leaves for a third party):
  * ``send_default_pii=False`` — no user ids, cookies, auth headers or IPs
    from the integrations.
  * ``max_request_body_size="never"`` — no request bodies, ever.
  * ``include_local_variables=False`` — a stack frame's locals can hold a
    password, a token or a prompt; the stack trace itself is enough.
  * ``before_send`` / ``before_send_transaction`` (``scrub_event``) — a second,
    recursive pass that drops request bodies/cookies, strips sensitive
    headers, blanks every key that looks like a credential, removes
    ``token=`` style query values and masks email addresses in messages.

Never reports from: pytest runs, LOADTEST_FAKE_AI, or a process without a DSN.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import MutableMapping
from typing import Any
from urllib.parse import parse_qsl, urlencode

from packages.core.logging import get_logger
from packages.core.settings import Settings, get_settings

log = get_logger(__name__)

FILTERED = "[Filtered]"

#: Key fragments that mark a value as a credential — matched case-insensitively
#: as a SUBSTRING of the key, anywhere in the event (so ``refresh_token``,
#: ``x-api-key``, ``smtp_password`` and ``stripe_secret`` all match).
_SENSITIVE_KEY_PARTS = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "api_key",
    "apikey",
    "api-key",
    "session",
    "credential",
    "private_key",
    "dsn",
    "otp",
    "signature",
    "csrf",
    "code_verifier",
)
#: Exact keys (substring matching would catch too much: "code" is in "encode").
_SENSITIVE_KEYS = {"code", "auth", "jwt", "state", "nonce", "x-forwarded-for", "x-real-ip"}

#: Request headers that are dropped outright, whatever their value.
_DROP_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "stripe-signature",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
}

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
#: `?token=...` / `&code=...` inside free text (a URL in an error message).
_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:token|code|state|access_token|refresh_token|key|signature)=)[^&\s#\"']+"
)
#: A bearer / JWT that ended up in a message.
_BEARER_RE = re.compile(r"(?i)bearer\s+[a-z0-9._~+/=-]+")
_JWT_RE = re.compile(r"\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b")

_active = False


def _is_sensitive_key(key: object) -> bool:
    k = str(key).strip().lower()
    return k in _SENSITIVE_KEYS or any(part in k for part in _SENSITIVE_KEY_PARTS)


def scrub_text(text: str) -> str:
    """Mask credentials and addresses inside free text."""
    text = _BEARER_RE.sub("Bearer " + FILTERED, text)
    text = _JWT_RE.sub(FILTERED, text)
    text = _QUERY_SECRET_RE.sub(lambda m: m.group(1) + FILTERED, text)

    def _mask(m: re.Match[str]) -> str:
        local, _, domain = m.group(0).partition("@")
        return f"{local[:1]}***@{domain.lower()}"

    return _EMAIL_RE.sub(_mask, text)


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > 20:
        return FILTERED
    if isinstance(value, dict):
        return {
            k: (FILTERED if _is_sensitive_key(k) and v not in (None, "") else _scrub(v, depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub(v, depth + 1) for v in value]
    if isinstance(value, tuple):
        return tuple(_scrub(v, depth + 1) for v in value)
    if isinstance(value, str):
        return scrub_text(value)
    return value


def _scrub_query_string(qs: Any) -> Any:
    if isinstance(qs, str):
        pairs = parse_qsl(qs, keep_blank_values=True)
        return urlencode([(k, FILTERED if _is_sensitive_key(k) else v) for k, v in pairs])
    if isinstance(qs, (list, tuple)):
        return [
            (k, FILTERED if _is_sensitive_key(k) else v) if isinstance(k, str) else (k, v)
            for k, v in qs
        ]
    return qs


def scrub_event(event: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """``before_send`` / ``before_send_transaction``: strip everything private."""
    request = event.get("request")
    if isinstance(request, dict):
        for field in ("data", "cookies", "env"):
            request.pop(field, None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {
                k: v for k, v in headers.items() if str(k).lower() not in _DROP_HEADERS
            }
        elif isinstance(headers, list):
            request["headers"] = [
                pair for pair in headers
                if not (isinstance(pair, (list, tuple)) and str(pair[0]).lower() in _DROP_HEADERS)
            ]
        if "query_string" in request:
            request["query_string"] = _scrub_query_string(request["query_string"])
    user = event.get("user")
    if isinstance(user, dict):
        # Keep only the opaque id (never set by us unless PII were on).
        event["user"] = {k: v for k, v in user.items() if k == "id"}
    scrubbed: dict[str, Any] = _scrub(event)
    return scrubbed


def _environment(s: Settings) -> str:
    return (
        (s.sentry_environment or "").strip()
        or (os.getenv("RAILWAY_ENVIRONMENT_NAME") or "").strip()
        or "development"
    )


def _release(s: Settings) -> str | None:
    return (s.sentry_release or "").strip() or (os.getenv("RAILWAY_GIT_COMMIT_SHA") or "").strip() or None


def monitoring_skip_reason(s: Settings | None = None) -> str | None:
    """Why this process must not report, or None when it should."""
    s = s or get_settings()
    if not (s.sentry_dsn or "").strip():
        return "SENTRY_DSN is not set"
    if "pytest" in sys.modules or os.getenv("PYTEST_CURRENT_TEST"):
        return "running under pytest"
    if s.loadtest_fake_ai:
        return "LOADTEST_FAKE_AI is on"
    return None


def sdk_options(service: str, s: Settings) -> dict[str, Any]:
    """The keyword arguments for ``sentry_sdk.init`` — one place, tested."""
    rate = min(max(float(s.sentry_traces_sample_rate), 0.0), 1.0)
    return {
        "dsn": (s.sentry_dsn or "").strip(),
        "environment": _environment(s),
        "release": _release(s),
        "send_default_pii": False,
        "max_request_body_size": "never",
        "include_local_variables": False,
        "traces_sample_rate": rate,
        "before_send": scrub_event,
        "before_send_transaction": scrub_event,
        # The container host name says nothing useful and is one more
        # identifier; the `service` tag says which process it was.
        "server_name": service,
    }


def init_monitoring(service: str, settings: Settings | None = None) -> bool:
    """Initialise Sentry for this process when configured. Returns whether it did."""
    global _active
    s = settings or get_settings()
    reason = monitoring_skip_reason(s)
    if reason:
        log.info("monitoring_off", service=service, reason=reason)
        return False
    import sentry_sdk

    sentry_sdk.init(**sdk_options(service, s))
    sentry_sdk.set_tag("service", service)
    _active = True
    log.info("monitoring_on", service=service, environment=_environment(s), release_set=_release(s) is not None)
    return True


def forward_errors_to_sentry(
    _logger: Any, method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: an ``error``/``critical`` log line becomes a Sentry event.

    The app logs through structlog's own printer, not the stdlib ``logging``
    module, so Sentry's logging integration never sees these lines. Many
    failures (a job that ends in status ``error``) are caught and logged rather
    than raised — without this they would never reach Sentry. The fields ride
    as ``extra`` and go through ``scrub_event`` like everything else.
    """
    if not _active or method not in ("error", "critical", "exception"):
        return event_dict
    try:
        import sentry_sdk

        name = str(event_dict.get("event", "error"))
        exc_info = event_dict.get("exc_info")
        with sentry_sdk.new_scope() as scope:
            for key, value in event_dict.items():
                if key not in ("event", "exc_info", "timestamp", "level"):
                    scope.set_extra(key, value if isinstance(value, (str, int, float, bool)) else repr(value)[:500])
            scope.fingerprint = ["log", name]
            if exc_info:
                err = sys.exc_info()[1] if exc_info is True else (
                    exc_info[1] if isinstance(exc_info, tuple) else exc_info
                )
                if isinstance(err, BaseException):
                    sentry_sdk.capture_exception(err)
                    return event_dict
            sentry_sdk.capture_message(name, level="error" if method != "critical" else "fatal")
    except Exception:  # noqa: BLE001, S110 — monitoring must never break logging (and must not log about itself: recursion)
        pass
    return event_dict
