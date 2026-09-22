"""Every attempt that reached the vendor is recorded — ok, retried, failed —
awaited inside the call (docs/token-billing-plan.md §3.1, §3.4)."""

import inspect
import types
from unittest.mock import AsyncMock, patch

import pytest

import packages.llm.gateway as gw
from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx


def _resp(inp: int = 100, out: int = 20, cached: int = 0):
    usage = types.SimpleNamespace(
        prompt_tokens=inp, completion_tokens=out, total_tokens=inp + out,
        prompt_tokens_details=types.SimpleNamespace(cached_tokens=cached),
    )
    msg = types.SimpleNamespace(content="ok", tool_calls=None)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)], usage=usage)


@pytest.fixture
def recorded(monkeypatch):
    calls: list[dict] = []

    async def fake(ctx, **kw):
        calls.append({"ctx": ctx, **kw})
        return 0

    monkeypatch.setattr(gw, "record_llm_attempt", fake)
    monkeypatch.setattr(gw, "check_ai_access", AsyncMock())
    monkeypatch.setattr(gw, "_RETRY_BACKOFF_SEC", 0.0)
    token = set_usage_ctx(UsageCtx(user_id=7, tenant_id=1, feature="video_cut", job_id="j1"))
    yield calls
    reset_usage_ctx(token)


async def test_a_retried_call_records_both_attempts(monkeypatch, recorded):
    attempts = iter([RuntimeError("Request timed out"), _resp(1_000, 200, cached=300)])

    async def flaky(**kwargs):
        item = next(attempts)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(gw.litellm, "acompletion", flaky)
    await gw.complete("hi", model="gemini/gemini-3.7-flash")
    assert [c["status"] for c in recorded] == ["retry", "ok"]
    ok = recorded[1]
    assert (ok["input_tokens"], ok["output_tokens"], ok["cached_tokens"]) == (1_000, 200, 300)
    assert ok["ctx"].job_id == "j1" and ok["model"] == "gemini/gemini-3.7-flash"


async def test_a_terminal_failure_is_recorded_then_raised(monkeypatch, recorded):
    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(side_effect=ValueError("400 bad request")))
    with pytest.raises(ValueError):
        await gw.complete("hi")
    assert [c["status"] for c in recorded] == ["failed"]
    assert recorded[0]["input_tokens"] == 0


async def test_a_connection_error_never_reached_the_vendor(monkeypatch, recorded):
    monkeypatch.setattr(
        gw.litellm, "acompletion", AsyncMock(side_effect=OSError("getaddrinfo failed"))
    )
    with pytest.raises(OSError):
        await gw.complete("hi")
    assert recorded == []


async def test_a_failed_stream_records_the_usage_it_already_reported(monkeypatch, recorded):
    async def dying_stream(**kwargs):
        async def gen():
            yield types.SimpleNamespace(
                choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="x"))],
                usage=types.SimpleNamespace(prompt_tokens=5_000, completion_tokens=40, total_tokens=5_040),
            )
            raise ValueError("stream broke: 400")

        return gen()

    monkeypatch.setattr(gw.litellm, "acompletion", dying_stream)
    with pytest.raises(ValueError):
        await gw.acompletion_stream_thinking(
            [{"role": "user", "content": "hi"}], project_uid="p", model="gemini/gemini-3.8-flash"
        )
    assert [(c["status"], c["input_tokens"], c["output_tokens"]) for c in recorded] == [("failed", 5_000, 40)]


async def test_no_context_means_no_recording_attempt(monkeypatch):
    fake = AsyncMock(return_value=0)
    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(return_value=_resp()))
    with patch.object(gw, "record_llm_attempt", fake), patch.object(gw, "check_ai_access", AsyncMock()):
        await gw.complete("hi")
    # Called with ctx=None — metering itself writes nothing for that.
    assert fake.await_args.args[0] is None


def test_recording_is_awaited_never_fire_and_forget():
    source = inspect.getsource(gw)
    assert "ensure_future" not in source
    assert "create_task(record" not in source
