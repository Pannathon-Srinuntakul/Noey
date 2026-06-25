"""Auth endpoint tests: login, refresh, me, register-disabled, invalid credentials."""

import pytest
from httpx import ASGITransport, AsyncClient

from services.api.main import app

ADMIN_EMAIL = "admin@noey.local"
ADMIN_PASSWORD = "ChangeMe123!"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_login_success():
    async with _client() as c:
        r = await c.post("/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "access_token" in body
    assert "refresh_token" in body
    assert body["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_login_wrong_password():
    async with _client() as c:
        r = await c.post("/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_unknown_email():
    async with _client() as c:
        r = await c.post("/auth/login", json={"email": "nobody@noey.local", "password": "x"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_requires_auth():
    async with _client() as c:
        r = await c.get("/auth/me")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_with_valid_token():
    async with _client() as c:
        login = await c.post("/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        token = login.json()["access_token"]
        r = await c.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == ADMIN_EMAIL
    assert body["tenant_slug"] == "default"
    assert body["is_admin"] is True


@pytest.mark.asyncio
async def test_refresh_works():
    async with _client() as c:
        login = await c.post("/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        refresh_token = login.json()["refresh_token"]
        r = await c.post("/auth/refresh", headers={"Authorization": f"Bearer {refresh_token}"})
    assert r.status_code == 200
    assert "access_token" in r.json()


@pytest.mark.asyncio
async def test_register_disabled():
    async with _client() as c:
        r = await c.post("/auth/register", json={"email": "new@noey.local", "password": "abc"})
    assert r.status_code == 403
    assert "closed" in r.json()["detail"]


@pytest.mark.asyncio
async def test_protected_route_401_without_token():
    """Existing analytics routes don't require auth yet (Phase 2 will add that).
    This test verifies the auth/me guard works properly."""
    async with _client() as c:
        r = await c.get("/auth/me")
    assert r.status_code == 401
