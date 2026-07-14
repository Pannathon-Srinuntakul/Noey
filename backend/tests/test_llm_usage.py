"""Tests for LLM usage tracking, limit enforcement, and gateway integration.

All DB calls are mocked — no real Postgres required.
"""

from __future__ import annotations

import types
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import packages.llm.gateway as gw
from packages.llm.usage import (
    MODEL_PRICES,
    UsageCtx,
    UsageLimitExceeded,
    _period_start,
    estimate_cost_usd,
    extract_stream_usage_from_chunks,
    extract_usage_tokens,
    get_usage_ctx,
    merge_provider_usage,
    reset_usage_ctx,
    set_usage_ctx,
    sum_tokens_since,
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


# ── 2. period_start ──────────────────────────────────────────────────────────

def _today_start() -> datetime:
    now = datetime.now(tz=timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def test_period_start_honors_reset_within_today():
    # A manual reset later in the same UTC day takes precedence.
    reset = _today_start() + timedelta(hours=5)
    assert _period_start(reset) == reset


def test_period_start_ignores_stale_reset():
    # A reset from a previous day is ignored → falls back to the daily start.
    stale = datetime(2020, 1, 1, tzinfo=timezone.utc)
    assert _period_start(stale) == _today_start()


def test_period_start_daily_fallback():
    result = _period_start(None)
    assert result == _today_start()
    assert result.hour == 0 and result.minute == 0 and result.second == 0


# ── 3. estimate_cost_usd ─────────────────────────────────────────────────────

def test_cost_known_model():
    cost = estimate_cost_usd("anthropic/claude-haiku-4-5-20251001", 1_000_000, 1_000_000)
    # input: 0.80 + output: 4.00 = $4.80
    assert abs(cost - 4.80) < 0.001


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

    with patch("packages.llm.gateway.check_limit", new=AsyncMock()):
        with patch("packages.llm.gateway.record_usage", new=AsyncMock()) as fake_record:
            token = set_usage_ctx(_ctx())
            try:
                await gw.acompletion_stream_thinking(
                    [{"role": "user", "content": "hi"}],
                    project_uid="proj-1",
                    model="gemini/gemini-3.1-pro-preview",
                )
                await asyncio.sleep(0)
            finally:
                reset_usage_ctx(token)

    assert captured.get("stream_options") == {"include_usage": True}
    fake_record.assert_awaited_once()
    assert fake_record.await_args.args[2:] == (1_000, 200)


def test_cost_unknown_model_uses_default():
    cost = estimate_cost_usd("some/unknown-model", 1_000_000, 0)
    # default input = 3.00 $/MTok
    assert abs(cost - 3.00) < 0.001


def test_zero_tokens_zero_cost():
    assert estimate_cost_usd("anthropic/claude-sonnet-4-6", 0, 0) == 0.0


# ── 4. check_limit: passes under limit ───────────────────────────────────────

@pytest.mark.asyncio
async def test_check_limit_passes_under_limit():
    """User has used 1000 tokens; limit is 50000 — should NOT raise."""
    ctx = _ctx(user_id=99)

    mock_user = MagicMock()
    mock_user.plan = "free"
    mock_user.usage_reset_at = None

    with (
        patch("packages.llm.usage.get_settings") as mock_settings,
        patch("packages.llm.usage.get_sessionmaker") as mock_maker,
    ):
        mock_settings.return_value.plan_token_limit.return_value = 50_000

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(side_effect=[
            MagicMock(),                                                       # SET search_path
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_user)),  # User query
            MagicMock(scalar=MagicMock(return_value=1_000)),                  # sum_tokens_since
        ])
        mock_maker.return_value.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_maker.return_value.return_value.__aexit__ = AsyncMock(return_value=False)

        # Should not raise
        from packages.llm.usage import check_limit
        await check_limit(ctx)


# ── 5. check_limit: raises when over limit ────────────────────────────────────

@pytest.mark.asyncio
async def test_check_limit_raises_over_limit():
    """User has used 60000 tokens; limit is 50000 — should raise UsageLimitExceeded."""
    ctx = _ctx(user_id=99)

    mock_user = MagicMock()
    mock_user.plan = "free"
    mock_user.usage_reset_at = None

    with (
        patch("packages.llm.usage.get_settings") as mock_settings,
        patch("packages.llm.usage.get_sessionmaker") as mock_maker,
    ):
        mock_settings.return_value.plan_token_limit.return_value = 50_000

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(side_effect=[
            MagicMock(),                                                       # SET search_path
            MagicMock(scalar_one_or_none=MagicMock(return_value=mock_user)),  # User query
            MagicMock(scalar=MagicMock(return_value=60_000)),                 # sum_tokens_since
        ])
        mock_maker.return_value.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_maker.return_value.return_value.__aexit__ = AsyncMock(return_value=False)

        from packages.llm.usage import check_limit
        with pytest.raises(UsageLimitExceeded) as exc_info:
            await check_limit(ctx)

        assert exc_info.value.used == 60_000
        assert exc_info.value.limit == 50_000
        assert exc_info.value.plan == "free"


# ── 6. unlimited plan never raises ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_unlimited_plan_never_raises():
    """Enterprise plan (limit=0) should never raise regardless of usage."""
    ctx = _ctx(user_id=7)

    mock_user = MagicMock()
    mock_user.plan = "enterprise"
    mock_user.usage_reset_at = None

    with (
        patch("packages.llm.usage.get_settings") as mock_settings,
        patch("packages.llm.usage.get_sessionmaker") as mock_maker,
    ):
        mock_settings.return_value.plan_token_limit.return_value = 0  # unlimited

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(
            return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=mock_user))
        )
        mock_maker.return_value.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_maker.return_value.return_value.__aexit__ = AsyncMock(return_value=False)

        from packages.llm.usage import check_limit
        await check_limit(ctx)  # must not raise even if token count were huge


# ── 7. reset_at resets the accounting window ─────────────────────────────────

@pytest.mark.asyncio
async def test_reset_at_resets_window():
    """Tokens before usage_reset_at should not count toward current period.

    We simulate this by verifying that sum_tokens_since is called with the
    explicit reset_at datetime (a same-day admin reset), not the daily start.
    """
    reset_time = _today_start() + timedelta(hours=1)
    ctx = _ctx(user_id=5)

    mock_user = MagicMock()
    mock_user.plan = "starter"
    mock_user.usage_reset_at = reset_time

    calls: list[datetime] = []

    async def fake_sum_tokens(user_id: int, since: datetime, session: object) -> int:
        calls.append(since)
        return 0  # well under limit

    with (
        patch("packages.llm.usage.get_settings") as mock_settings,
        patch("packages.llm.usage.get_sessionmaker") as mock_maker,
        patch("packages.llm.usage.sum_tokens_since", side_effect=fake_sum_tokens),
    ):
        mock_settings.return_value.plan_token_limit.return_value = 500_000

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(
            return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=mock_user))
        )
        mock_maker.return_value.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_maker.return_value.return_value.__aexit__ = AsyncMock(return_value=False)

        from packages.llm.usage import check_limit
        await check_limit(ctx)

    assert len(calls) == 1
    assert calls[0] == reset_time  # must use the explicit reset_at, not start-of-month


# ── 8. gateway records usage on successful call ───────────────────────────────

@pytest.mark.asyncio
async def test_gateway_records_on_successful_call(monkeypatch):
    """Integration: gateway.acompletion() should schedule record_usage when ctx is set."""
    recorded: list[tuple] = []

    async def fake_record(ctx, model, inp, out):
        recorded.append((ctx, model, inp, out))

    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(
        return_value=_fake_litellm_response(input_tok=200, output_tok=80)
    ))

    # Patch check_limit and record_usage at the gateway module level
    # (they're imported there, so patching the source module won't affect it)
    with patch("packages.llm.gateway.check_limit", new=AsyncMock()):
        with patch("packages.llm.gateway.record_usage", side_effect=fake_record):
            ctx = _ctx(user_id=42)
            token = set_usage_ctx(ctx)
            try:
                await gw.complete("test prompt")
                # Let the fire-and-forget coroutine run
                await asyncio.sleep(0)
            finally:
                reset_usage_ctx(token)

    assert len(recorded) == 1
    rec_ctx, model, inp, out = recorded[0]
    assert rec_ctx.user_id == 42
    assert inp == 200
    assert out == 80


# ── 9. gateway raises HTTP 429 when limit exceeded ───────────────────────────

@pytest.mark.asyncio
async def test_gateway_raises_429_on_limit_exceeded(monkeypatch):
    """gateway.acompletion() should raise HTTP 429 when check_limit fires."""
    from fastapi import HTTPException

    async def fake_check_limit(ctx):
        raise UsageLimitExceeded(used=60_000, limit=50_000, plan="free")

    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(return_value=_fake_litellm_response()))

    with patch("packages.llm.gateway.check_limit", side_effect=fake_check_limit):
        ctx = _ctx(user_id=99)
        token = set_usage_ctx(ctx)
        try:
            with pytest.raises(HTTPException) as exc_info:
                await gw.complete("blocked call")
            assert exc_info.value.status_code == 429
            assert exc_info.value.detail["error"] == "token_limit_exceeded"
        finally:
            reset_usage_ctx(token)
