"""Tests for LLM usage tracking, the access gate, and gateway integration.

All DB calls are mocked — no real Postgres required. Plan limits moved to
packages/billing (rolling windows reserved at job start — tests/test_runs.py;
the per-call job ceiling — tests/test_guard.py).
"""

from __future__ import annotations

import types
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import packages.llm.gateway as gw
from packages.llm.usage import (
    UsageCtx,
    extract_stream_usage_from_chunks,
    extract_usage_tokens,
    get_usage_ctx,
    merge_provider_usage,
    reset_usage_ctx,
    set_usage_ctx,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _fake_litellm_response(text: str = "ok", input_tok: int = 100, output_tok: int = 50):
    usage = types.SimpleNamespace(prompt_tokens=input_tok, completion_tokens=output_tok)
    msg = types.SimpleNamespace(content=text, tool_calls=None)
    choice = types.SimpleNamespace(message=msg)
    return types.SimpleNamespace(choices=[choice], usage=usage)


def _ctx(user_id: int = 1, tenant_id: int = 1, feature: str = "chat", ref: str | None = "sess-1") -> UsageCtx:
    return UsageCtx(user_id=user_id, tenant_id=tenant_id, feature=feature, reference_id=ref)


# ── 1. ContextVar propagation ─────────────────────────────────────────────────

def test_set_and_get_usage_ctx():
    ctx = _ctx()
    token = set_usage_ctx(ctx)
    try:
        retrieved = get_usage_ctx()
        assert retrieved is ctx
        assert retrieved.user_id == 1
        assert retrieved.feature == "chat"
    finally:
        reset_usage_ctx(token)


def test_reset_restores_previous():
    assert get_usage_ctx() is None
    ctx = _ctx()
    token = set_usage_ctx(ctx)
    assert get_usage_ctx() is not None
    reset_usage_ctx(token)
    assert get_usage_ctx() is None


# ── 2. token extraction ───────────────────────────────────────────────────────

def test_extract_usage_tokens_uses_total_when_thinking_not_in_completion():
    usage = types.SimpleNamespace(prompt_tokens=10_000, completion_tokens=500, total_tokens=15_000)
    inp, out = extract_usage_tokens(usage)
    assert inp == 10_000
    assert out == 5_000


def test_extract_usage_tokens_normal_when_total_matches():
    usage = types.SimpleNamespace(prompt_tokens=100, completion_tokens=50, total_tokens=150)
    inp, out = extract_usage_tokens(usage)
    assert inp == 100
    assert out == 50


def test_extract_stream_usage_from_chunks_uses_max_prompt():
    partial = types.SimpleNamespace(
        usage=types.SimpleNamespace(prompt_tokens=0, completion_tokens=500, total_tokens=500),
    )
    final = types.SimpleNamespace(
        usage=types.SimpleNamespace(prompt_tokens=48_450, completion_tokens=2_063, total_tokens=50_513),
    )
    inp, out = extract_stream_usage_from_chunks([partial, final])
    assert inp == 48_450
    assert out == 2_063


def test_extract_stream_usage_from_chunks_thinking_via_total():
    final = types.SimpleNamespace(
        usage=types.SimpleNamespace(prompt_tokens=10_000, completion_tokens=500, total_tokens=15_000),
    )
    inp, out = extract_stream_usage_from_chunks([final])
    assert inp == 10_000
    assert out == 5_000


def test_merge_provider_usage_never_drops_higher_input():
    merged = merge_provider_usage((0, 2_063), (48_450, 2_000))
    assert merged == (48_450, 2_063)


@pytest.mark.asyncio
async def test_stream_thinking_requests_include_usage(monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)

        async def _gen():
            yield types.SimpleNamespace(
                choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="ok"))],
                usage=types.SimpleNamespace(
                    prompt_tokens=0,
                    completion_tokens=10,
                    total_tokens=10,
                ),
            )
            yield types.SimpleNamespace(
                choices=[types.SimpleNamespace(delta=types.SimpleNamespace())],
                usage=types.SimpleNamespace(
                    prompt_tokens=1_000,
                    completion_tokens=200,
                    total_tokens=1_200,
                ),
            )

        return _gen()

    def fake_builder(chunks, messages=None):
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="ok"))],
            usage=types.SimpleNamespace(prompt_tokens=0, completion_tokens=200, total_tokens=200),
        )

    monkeypatch.setattr(gw.litellm, "acompletion", fake_acompletion)
    monkeypatch.setattr(gw.litellm, "stream_chunk_builder", fake_builder)

    with patch("packages.llm.gateway.check_ai_access", new=AsyncMock()):
        with patch("packages.llm.gateway.record_llm_attempt", new=AsyncMock()) as fake_record:
            token = set_usage_ctx(_ctx())
            try:
                await gw.acompletion_stream_thinking(
                    [{"role": "user", "content": "hi"}],
                    project_uid="proj-1",
                    model="gemini/gemini-3.1-pro-preview",
                )
            finally:
                reset_usage_ctx(token)

    assert captured.get("stream_options") == {"include_usage": True}
    # Awaited inside the call (durable recording), not scheduled for later.
    fake_record.assert_awaited_once()
    kw = fake_record.await_args.kwargs
    assert (kw["status"], kw["input_tokens"], kw["output_tokens"]) == ("ok", 1_000, 200)


# ── 3. the access gate before every model call ──────────────────────────────

def _session_returning(user):  # noqa: ANN001, ANN202
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        MagicMock(),  # SET search_path
        MagicMock(scalar_one_or_none=MagicMock(return_value=user)),
    ])
    maker = MagicMock()
    maker.return_value.__aenter__ = AsyncMock(return_value=session)
    maker.return_value.__aexit__ = AsyncMock(return_value=False)
    return maker


@pytest.mark.asyncio
async def test_check_ai_access_refuses_an_unverified_account(monkeypatch):
    from packages.llm import usage
    from packages.llm.usage import EmailNotVerified, check_ai_access

    user = types.SimpleNamespace(is_admin=False, email_verified_at=None, plan="pro")
    monkeypatch.setattr(usage, "get_sessionmaker", lambda: _session_returning(user))
    with pytest.raises(EmailNotVerified):
        await check_ai_access(_ctx(user_id=9))


@pytest.mark.asyncio
async def test_check_ai_access_never_counts_tokens(monkeypatch):
    """A verified account passes whatever it used: limits are not checked per call any more."""
    from packages.llm import usage
    from packages.llm.usage import check_ai_access

    user = types.SimpleNamespace(is_admin=False, email_verified_at="2026-01-01", plan="free")
    monkeypatch.setattr(usage, "get_sessionmaker", lambda: _session_returning(user))
    await check_ai_access(_ctx(user_id=9))
    assert not hasattr(usage, "check_limit") and not hasattr(usage, "UsageLimitExceeded")


# ── 8. gateway records usage on successful call ───────────────────────────────

@pytest.mark.asyncio
async def test_gateway_records_on_successful_call(monkeypatch):
    """Integration: gateway.acompletion() records the call (awaited) when ctx is set."""
    recorded: list[tuple] = []

    async def fake_record(ctx, *, model, status, input_tokens, cached_tokens, output_tokens):
        recorded.append((ctx, model, input_tokens, output_tokens))
        return 0

    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(
        return_value=_fake_litellm_response(input_tok=200, output_tok=80)
    ))

    # Patch the access gate and the recorder at the gateway module level
    # (they're imported there, so patching the source module won't affect it)
    with patch("packages.llm.gateway.check_ai_access", new=AsyncMock()):
        with patch("packages.llm.gateway.record_llm_attempt", side_effect=fake_record):
            ctx = _ctx(user_id=42)
            token = set_usage_ctx(ctx)
            try:
                await gw.complete("test prompt")
            finally:
                reset_usage_ctx(token)

    assert len(recorded) == 1
    rec_ctx, model, inp, out = recorded[0]
    assert rec_ctx.user_id == 42
    assert inp == 200
    assert out == 80


# ── 9. gateway raises HTTP 403 for an unverified account ─────────────────────

@pytest.mark.asyncio
async def test_gateway_raises_403_for_an_unverified_account(monkeypatch):
    from fastapi import HTTPException

    from packages.llm.usage import EmailNotVerified

    async def refuse(ctx):  # noqa: ANN001, ANN202
        raise EmailNotVerified()

    sent = AsyncMock(return_value=_fake_litellm_response())
    monkeypatch.setattr(gw.litellm, "acompletion", sent)
    with patch("packages.llm.gateway.check_ai_access", side_effect=refuse):
        token = set_usage_ctx(_ctx(user_id=99))
        try:
            with pytest.raises(HTTPException) as exc_info:
                await gw.complete("blocked call")
        finally:
            reset_usage_ctx(token)
    assert exc_info.value.status_code == 403
    sent.assert_not_awaited()
