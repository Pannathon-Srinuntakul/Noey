"""Settings endpoint tests."""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from packages.db.models import AppSetting
from packages.db.session import get_sessionmaker
from services.api.main import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _reset_settings():
    maker = get_sessionmaker()
    async with maker() as s:
        await s.execute(delete(AppSetting))
        await s.commit()


@pytest.mark.asyncio
async def test_put_llm_model_persists():
    await _reset_settings()
    async with _client() as c:
        await c.put("/settings", json={"llm_model": "ollama/llama3", "llm_base_url": "http://x:11434"})
        r = await c.get("/settings")
    body = r.json()
    assert body["llm_model"] == "ollama/llama3"
    assert body["llm_base_url"] == "http://x:11434"
    await _reset_settings()
