"""Cross-cutting HTTP middleware: request id + security headers.

Both are raw ASGI middleware rather than Starlette's ``BaseHTTPMiddleware``:
that class runs the downstream app in a separate task, so a contextvar bound
here would not be visible to the endpoint (and a response streamed by
``FileResponse`` / Range replies would be buffered through it). A raw
middleware runs in the request's own task and only touches the headers of the
``http.response.start`` message, so bodies flow through untouched.

Request id
----------
Every request carries one — the ``X-Request-ID`` the caller sent (a client or
the front proxy), else a fresh uuid4 — bound to structlog's contextvars for the
whole request and echoed on the response, so one id ties together a log line
here, the reply the client saw, and (once the routers pass it on) the arq job
it started. ``current_request_id()`` is how the rest of the process reads it.

Security headers
----------------
Set on every response, including the ones CORS answers itself and the ones the
error handlers build — anything a browser gets should carry them, and a
middleware is the only place that sees all of them.
"""

from __future__ import annotations

import re
import uuid

import structlog
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_ID_HEADER = "x-request-id"

#: What a caller-supplied id may look like. Anything else is replaced, not
#: sanitised: the id lands verbatim in every log line and in a response
#: header, and a newline or a kilobyte of junk in either is a log-injection /
#: header-abuse vector nobody should have to think about downstream.
_ID_OK = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

#: One year, subdomains included — the value HSTS preload lists expect.
#: Set only when the request came over TLS: a browser ignores HSTS on plain
#: http anyway, and emitting it there just hides a misconfigured proxy.
_HSTS = "max-age=31536000; includeSubDomains"

#: Path prefixes whose responses must never land in a shared or browser cache:
#: tokens, account details, admin data. Anything else keeps whatever the
#: handler set (the release redirect and media replies rely on their own).
_NO_STORE_PREFIXES = ("/auth", "/admin")


def current_request_id() -> str | None:
    """The id of the request being handled in this task, or None outside one.

    Routers should pass this into every arq enqueue (``request_id=…``) so the
    worker can bind the same id and a job's log lines join the request that
    started it. Only the API middleware sets it; a worker task reads its copy
    from the job kwargs instead.
    """
    value = structlog.contextvars.get_contextvars().get("request_id")
    return str(value) if value else None


def bind_request_user(user_id: int, tenant_id: int | None = None) -> None:
    """Attach the resolved account to this request's log context.

    Called from ``deps.current_user`` once the JWT resolved. Dependencies run
    in the request task, so the binding reaches the endpoint and everything it
    logs; the middleware clears it when the request ends.
    """
    fields: dict[str, int] = {"user_id": int(user_id)}
    if tenant_id is not None:
        fields["tenant_id"] = int(tenant_id)
    structlog.contextvars.bind_contextvars(**fields)


def _incoming_request_id(scope: Scope) -> str:
    for name, value in scope.get("headers", ()):
        if name == b"x-request-id":
            candidate = value.decode("latin-1").strip()
            if _ID_OK.match(candidate):
                return candidate
            break
    return uuid.uuid4().hex


def _is_https(scope: Scope) -> bool:
    if scope.get("scheme") == "https":
        return True
    # Behind Railway's edge (and most proxies) the socket is plain http and
    # the original scheme rides on X-Forwarded-Proto. uvicorn only rewrites
    # ``scope["scheme"]`` from it for proxies in --forwarded-allow-ips, which
    # a platform proxy is not, so it has to be read here.
    for name, value in scope.get("headers", ()):
        if name == b"x-forwarded-proto":
            return value.decode("latin-1").split(",")[0].strip().lower() == "https"
    return False


class BodySizeLimitMiddleware:
    """413 before the body is parsed when ``Content-Length`` says it cannot
    fit any route's cap.

    The routes check their own caps against the parsed parts, but by then
    FastAPI has spooled the whole multipart body — a 10 GB PUT reached the
    disk before being refused. This is the pre-parse line: one generous
    ceiling (the largest per-file cap plus room for a many-part manifest)
    that no legitimate request exceeds; the exact per-route cap still applies
    after parsing. Chunked bodies with no length pass through to the routes'
    streaming caps.
    """

    def __init__(self, app: ASGIApp, *, limit_bytes: int) -> None:
        self.app = app
        self.limit = int(limit_bytes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self.limit > 0:
            for name, value in scope.get("headers", ()):
                if name == b"content-length":
                    try:
                        length = int(value.decode("latin-1"))
                    except ValueError:
                        length = -1
                    if length > self.limit:
                        body = (
                            '{"detail":"ไฟล์ใหญ่เกินกว่าที่เซิร์ฟเวอร์รับได้ในคำขอเดียว"}'
                        ).encode("utf-8")
                        await send(
                            {
                                "type": "http.response.start",
                                "status": 413,
                                "headers": [
                                    (b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode()),
                                ],
                            }
                        )
                        await send({"type": "http.response.body", "body": body})
                        return
                    break
        await self.app(scope, receive, send)


class RequestContextMiddleware:
    """Request id in, request id + security headers out."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope)
        https = _is_https(scope)
        path = str(scope.get("path") or "")
        no_store = any(path == p or path.startswith(p + "/") for p in _NO_STORE_PREFIXES)

        response_started = False

        async def send_with_headers(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                headers = MutableHeaders(scope=message)
                headers[REQUEST_ID_HEADER] = request_id
                headers["x-content-type-options"] = "nosniff"
                headers["referrer-policy"] = "strict-origin-when-cross-origin"
                if https:
                    headers["strict-transport-security"] = _HSTS
                if no_store:
                    # Overrides, not defaults: an accidental ``public`` from a
                    # handler under these prefixes is exactly the leak this
                    # exists to prevent.
                    headers["cache-control"] = "no-store"
            await send(message)

        # A fresh context per request. uvicorn schedules each request cycle as
        # its own task, so nothing should be here already — clearing first
        # means a stale ``user_id`` from a reused context can never be logged
        # against a different caller.
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            await self.app(scope, receive, send_with_headers)
        except Exception:
            # An unhandled exception is caught OUTSIDE this layer, by
            # Starlette's ServerErrorMiddleware, whose 500 would carry none of
            # our headers — and the 500 is the reply whose request id matters
            # most (it is what the user quotes and what we grep the logs for).
            # So send the same plain 500 from here, then re-raise: the outer
            # layer sees the response already started, skips its own, and the
            # server still logs the traceback.
            if not response_started:
                await send_with_headers(
                    {
                        "type": "http.response.start",
                        "status": 500,
                        "headers": [(b"content-type", b"text/plain; charset=utf-8")],
                    }
                )
                await send({"type": "http.response.body", "body": b"Internal Server Error"})
            raise
        finally:
            structlog.contextvars.clear_contextvars()
