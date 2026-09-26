"""Security headers ride on every response (services/api/middleware.py).

`/health` needs no database, so these run anywhere. The preflight case is the
one that justifies the middleware order in main.py: CORS answers OPTIONS
without calling further in, and the headers still have to be on that reply.
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from packages.core.settings import get_settings
from services.api.main import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_plain_http_response_carries_the_static_headers_and_no_hsts():
    async with _client() as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    # Plain http: a browser would ignore HSTS anyway, and sending it hides a
    # proxy that forgot to say the request was TLS.
    assert "strict-transport-security" not in r.headers
    assert "cache-control" not in r.headers


async def test_hsts_when_the_socket_is_https():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as c:
        r = await c.get("/health")
    assert r.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"


async def test_hsts_when_a_proxy_says_the_client_used_https():
    async with _client() as c:
        r = await c.get("/health", headers={"x-forwarded-proto": "https"})
    assert r.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"


async def test_forwarded_proto_http_does_not_get_hsts():
    async with _client() as c:
        r = await c.get("/health", headers={"x-forwarded-proto": "http"})
    assert "strict-transport-security" not in r.headers


async def test_auth_and_admin_replies_are_never_cached():
    async with _client() as c:
        # 401/422 paths — no database needed, and error replies must carry
        # the header exactly like successes.
        auth = await c.get("/auth/me")
        admin = await c.get("/admin/overview")
        nested = await c.post("/auth/login", json={})
    assert auth.headers["cache-control"] == "no-store"
    assert admin.headers["cache-control"] == "no-store"
    assert nested.headers["cache-control"] == "no-store"


async def test_cors_preflight_still_carries_cors_and_security_headers():
    origin = get_settings().cors_origins[0]
    async with _client() as c:
        r = await c.options(
            "/auth/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    assert r.status_code == 200, r.text
    # CORS answered this itself — its headers are intact …
    assert r.headers["access-control-allow-origin"] == origin
    assert "POST" in r.headers["access-control-allow-methods"]
    # … and the outer middleware still decorated the reply.
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers.get("x-request-id")


async def test_cors_simple_request_exposes_the_request_id():
    origin = get_settings().cors_origins[0]
    async with _client() as c:
        r = await c.get("/health", headers={"Origin": origin})
    assert r.headers["access-control-allow-origin"] == origin
    exposed = {h.strip().lower() for h in r.headers["access-control-expose-headers"].split(",")}
    assert "x-request-id" in exposed
    assert "retry-after" in exposed


async def test_a_body_larger_than_any_cap_is_refused_before_parsing():
    """The Content-Length alone ends it: no route, no parser, no disk."""
    from packages.core.settings import get_settings
    from tests.admin_helpers import client

    limit = get_settings().max_upload_bytes
    async with client() as c:
        r = await c.post(
            "/videos/x/files/final.mp4",
            headers={"content-length": str(int(limit * 1.05) + 1), "content-type": "video/mp4"},
        )
    assert r.status_code == 413
    assert "ใหญ่เกิน" in r.json()["detail"]
    assert r.headers.get("x-request-id")
