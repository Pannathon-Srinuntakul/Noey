"""Settings endpoint tests."""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from packages.db.models import AppSetting
from packages.db.session import get_sessionmaker
from services.api.main import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _admin_headers(c: AsyncClient) -> dict[str, str]:
    """The settings endpoints are admin-only: they name the model and which
    vendors are configured, which is exactly what a user must never see."""
    r = await c.post(
        "/auth/login", json={"email": "admin@noey.local", "password": "ChangeMe123!"}
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _reset_settings():
    maker = get_sessionmaker()
    async with maker() as s:
        await s.execute(delete(AppSetting))
        await s.commit()


@pytest.mark.asyncio
async def test_put_llm_model_persists():
    await _reset_settings()
    async with _client() as c:
        h = await _admin_headers(c)
        await c.put(
            "/settings",
            json={"llm_model": "ollama/llama3", "llm_base_url": "http://x:11434"},
            headers=h,
        )
        r = await c.get("/settings", headers=h)
    body = r.json()
    assert body["llm_model"] == "ollama/llama3"
    assert body["llm_base_url"] == "http://x:11434"
    await _reset_settings()


@pytest.mark.asyncio
async def test_settings_refuses_anonymous_readers():
    """An anonymous GET used to return the exact model id and which vendors had
    keys — the two facts the product must never hand out. A browser address bar
    was enough."""
    async with _client() as c:
        r = await c.get("/settings")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_settings_is_not_in_the_public_schema():
    """`/openapi.json` is off by default, but the route is also marked out of
    the schema so enabling docs in a dev environment does not republish it."""
    from services.api.main import app as _app

    for route in _app.routes:
        if getattr(route, "path", "") == "/settings":
            assert getattr(route, "include_in_schema", True) is False
