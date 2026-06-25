"""LLM gateway tests — all mocked, no real provider calls."""

import types

import pytest

import packages.llm.gateway as gw
from packages.llm.config import LLM_REQUEST_TIMEOUT_SEC
from packages.llm.tools import tool_schema


def _fake_response(text="hi", tool_calls=None):
    msg = types.SimpleNamespace(content=text, tool_calls=tool_calls)
    choice = types.SimpleNamespace(message=msg)
    return types.SimpleNamespace(choices=[choice])


@pytest.mark.asyncio
async def test_complete_returns_text(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return _fake_response("hello world")

    monkeypatch.setattr(gw.litellm, "acompletion", fake_acompletion)
    out = await gw.complete("hi there")
    assert out == "hello world"
    # model from settings is forwarded
    assert "model" in captured
    assert captured["messages"][-1] == {"role": "user", "content": "hi there"}
    assert captured.get("timeout") == LLM_REQUEST_TIMEOUT_SEC


@pytest.mark.asyncio
async def test_system_prompt_prepended(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return _fake_response()

    monkeypatch.setattr(gw.litellm, "acompletion", fake_acompletion)
    await gw.complete("q", system="be terse")
    roles = [m["role"] for m in captured["messages"]]
    assert roles == ["system", "user"]


@pytest.mark.asyncio
async def test_tools_unsupported_falls_back(monkeypatch):
    calls = []

    async def fake_acompletion(**kwargs):
        calls.append(kwargs)
        if "tools" in kwargs:
            raise RuntimeError("this model does not support tool calling")
        return _fake_response("answered without tools")

    monkeypatch.setattr(gw.litellm, "acompletion", fake_acompletion)
    tools = [tool_schema("q", "desc", {"type": "object", "properties": {}})]
    msg = await gw.chat_once([{"role": "user", "content": "hi"}], tools=tools)
    assert msg.content == "answered without tools"
    # first call had tools, retry dropped them
    assert "tools" in calls[0]
    assert "tools" not in calls[1]


@pytest.mark.asyncio
async def test_real_error_propagates(monkeypatch):
    async def fake_acompletion(**kwargs):
        raise RuntimeError("rate limit exceeded")

    monkeypatch.setattr(gw.litellm, "acompletion", fake_acompletion)
    with pytest.raises(RuntimeError, match="rate limit"):
        await gw.complete("hi")


def test_tool_schema_shape():
    t = tool_schema("query_sales", "Query sales", {"type": "object", "properties": {}})
    assert t["type"] == "function"
    assert t["function"]["name"] == "query_sales"
