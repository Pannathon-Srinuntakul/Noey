"""Request id: read or minted, bound to the log context, echoed back."""

from __future__ import annotations

import re

import structlog
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.api.main import app
from services.api.middleware import (
    RequestContextMiddleware,
    bind_request_user,
    current_request_id,
)


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_a_supplied_id_is_echoed():
    async with _client() as c:
        r = await c.get("/health", headers={"X-Request-ID": "req-abc.123_X"})
    assert r.headers["x-request-id"] == "req-abc.123_X"


async def test_a_missing_id_is_minted_as_uuid4_hex():
    async with _client() as c:
        a = await c.get("/health")
        b = await c.get("/health")
    assert re.fullmatch(r"[0-9a-f]{32}", a.headers["x-request-id"])
    assert a.headers["x-request-id"] != b.headers["x-request-id"]


async def test_a_malformed_id_is_replaced_not_echoed():
    # Header values cannot carry a raw newline through httpx, so the
    # realistic abuse cases are length and charset.
    async with _client() as c:
        junk = await c.get("/health", headers={"X-Request-ID": "x" * 129})
        spaced = await c.get("/health", headers={"X-Request-ID": "has space"})
        symbols = await c.get("/health", headers={"X-Request-ID": "<script>"})
    for r in (junk, spaced, symbols):
        assert re.fullmatch(r"[0-9a-f]{32}", r.headers["x-request-id"])


async def test_the_id_is_bound_to_the_log_context_inside_the_endpoint():
    seen: dict[str, object] = {}
    inner = FastAPI()

    @inner.get("/probe")
    async def probe() -> dict:
        seen.update(structlog.contextvars.get_contextvars())
        seen["via_helper"] = current_request_id()
        bind_request_user(42, 7)
        return {}

    inner.add_middleware(RequestContextMiddleware)
    async with AsyncClient(transport=ASGITransport(app=inner), base_url="http://t") as c:
        await c.get("/probe", headers={"X-Request-ID": "trace-1"})

    assert seen["request_id"] == "trace-1"
    assert seen["via_helper"] == "trace-1"
    # The request is over: nothing it bound (id, or the user the dependency
    # attached) may leak into whatever this task does next.
    assert structlog.contextvars.get_contextvars() == {}
    assert current_request_id() is None


async def test_the_context_is_cleared_even_when_the_endpoint_raises():
    inner = FastAPI()

    @inner.get("/boom")
    async def boom() -> dict:
        raise RuntimeError("nope")

    inner.add_middleware(RequestContextMiddleware)
    transport = ASGITransport(app=inner, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/boom", headers={"X-Request-ID": "trace-2"})
    assert r.status_code == 500
    # Starlette's ServerErrorMiddleware built the 500 inside our layer, so the
    # reply still names the request it belongs to.
    assert r.headers["x-request-id"] == "trace-2"
    assert structlog.contextvars.get_contextvars() == {}


def test_bind_request_user_adds_user_and_tenant():
    structlog.contextvars.clear_contextvars()
    try:
        bind_request_user(5)
        assert structlog.contextvars.get_contextvars() == {"user_id": 5}
        bind_request_user(5, 9)
        assert structlog.contextvars.get_contextvars() == {"user_id": 5, "tenant_id": 9}
    finally:
        structlog.contextvars.clear_contextvars()
