"""Guard layers 2 and 3: the per-call job ceiling and the circuit breaker.

The gateway half mocks LiteLLM (no network); the breaker half reads the
real local database (today's recorded cost), with a cap set far above or
below whatever the dev database already holds.
"""

import types
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import packages.llm.gateway as gw
from packages.billing import guard, rate_card, runs, wallet
from packages.billing.estimate import MODE_PROFILES
from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx
from tests.admin_helpers import _admin_env, db  # noqa: F401  (fixture)

RESETS = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)


def _meter(ceiling: int | None = 100_000, **kw) -> guard.RunMeter:
    return guard.RunMeter(run_id="r1", ceiling=ceiling, default_max_output=8_000, **kw)


def _resp(inp: int = 1_000, out: int = 500):
    usage = types.SimpleNamespace(prompt_tokens=inp, completion_tokens=out, total_tokens=inp + out)
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="ok", tool_calls=None))], usage=usage
    )


@pytest.fixture
def quiet_gateway(monkeypatch):
    """No DB, no Redis, no breaker: only the guard decides."""
    monkeypatch.setattr(gw, "check_ai_access", AsyncMock())
    monkeypatch.setattr(guard, "breaker_hard_stop", AsyncMock(return_value=False))
    token = set_usage_ctx(UsageCtx(user_id=1, tenant_id=1, feature="video_cut", run_id="r1"))
    yield
    reset_usage_ctx(token)


# ── the budget of one call ───────────────────────────────────────────────────

def test_a_call_is_priced_before_it_is_sent():
    meter = _meter()
    msgs = [{"role": "user", "content": "x" * 3_000}]
    budget = guard.call_budget(meter, "gemini/gemini-3.7-flash", msgs, {})
    assert budget == rate_card.tokens_for_llm("gemini-3.7-flash", 1_000, 0, 8_000)
    explicit = guard.call_budget(meter, "gemini-3.7-flash", msgs, {"max_tokens": 100}, input_tokens=50)
    assert explicit == rate_card.tokens_for_llm("gemini-3.7-flash", 50, 0, 100)


def test_video_and_image_parts_are_priced_from_the_run():
    meter = _meter(media_input_tokens=6_000)
    video = [{"role": "user", "content": [{"type": "file", "file": {"file_id": "f", "format": "video/mp4"}}]}]
    frames = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}] * 3}]
    assert guard.input_budget(meter, video) == 6_000
    assert guard.input_budget(meter, frames) == 3 * 258


def test_the_meter_uses_the_profile_the_estimate_used():
    run = types.SimpleNamespace(
        id="r", kind="analyze_video", unlimited=False, ceiling_tokens=90_000, actual_tokens=1_234,
        media_sec=60.0, precision="high", estimate_tokens=75_000,
    )
    meter = guard.meter_for_run(run)
    assert meter.default_max_output == MODE_PROFILES["analyze_video"].max_output
    assert meter.media_input_tokens == 60 * 300 and meter.spent == 1_234 and meter.ceiling == 90_000
    assert guard.meter_for_run(types.SimpleNamespace(**{**run.__dict__, "unlimited": True})).ceiling is None


def test_admit_stops_before_the_ceiling_and_stays_stopped():
    meter = _meter(ceiling=10_000)
    guard.admit(meter, 6_000)
    guard.settle_call(meter, 6_000, 5_000)
    assert (meter.spent, meter.in_flight) == (5_000, 0)
    guard.admit(meter, 5_000)  # exactly at the ceiling
    guard.settle_call(meter, 5_000, 4_000)
    with pytest.raises(guard.RunBudgetExceeded):
        guard.admit(meter, 1_001 + 1_000)
    assert meter.stopped
    with pytest.raises(guard.RunBudgetExceeded):
        guard.admit(meter, 1)  # once stopped, nothing more is sent


def test_parallel_calls_count_each_other_in_flight():
    meter = _meter(ceiling=10_000)
    guard.admit(meter, 6_000)
    with pytest.raises(guard.RunBudgetExceeded):
        guard.admit(meter, 6_000)  # the first is still in flight


def test_an_optional_call_is_skipped_without_stopping_the_run():
    meter = _meter(ceiling=10_000, spent=9_000)
    with guard.optional_call(), pytest.raises(guard.OptionalCallSkipped):
        guard.admit(meter, 5_000)
    assert not meter.stopped
    guard.admit(meter, 500)


def test_unlimited_meters_never_stop():
    meter = _meter(ceiling=None, unlimited=True)
    guard.admit(meter, 10**12)


# ── the plan's window, which nothing reserves any more ───────────────────────

def _quota(headroom: int, **kw) -> runs.QuotaSnapshot:
    fields = {
        "window": "weekly", "headroom": headroom, "resets_at": RESETS,
        "wallet_satang": 0, "wallet_allowance": 0,
    }
    return runs.QuotaSnapshot(**{**fields, **kw})


def test_a_run_pauses_when_the_plans_window_runs_out_mid_run():
    """The pause carries what the editor needs to offer the balance — without
    it web/src/lib/usageLimits.ts can only say "error"."""
    meter = _meter(ceiling=500_000, quota=_quota(10_000), estimate=40_000)
    guard.admit(meter, 4_000)
    guard.settle_call(meter, 4_000, 4_000)
    with pytest.raises(guard.QuotaExhausted) as exc:
        guard.admit(meter, 7_000)  # 4 000 spent + 7 000 > 10 000 left
    payload = exc.value.payload()
    assert payload["code"] == "limit_reached" and payload["window"] == "weekly"
    assert payload["resets_at"] == runs.iso(RESETS)
    assert payload["wallet_can_cover"] is False and payload["wallet_satang"] > 0
    assert meter.stopped and "โควตาหมด" in payload["message"]
    # Well inside this run's OWN ceiling: it is the plan that stopped it.
    assert meter.ceiling == 500_000


def test_the_pause_says_the_balance_can_carry_it_when_it_can():
    meter = _meter(ceiling=500_000, quota=_quota(1_000, wallet_satang=100_000), estimate=20_000)
    with pytest.raises(guard.QuotaExhausted) as exc:
        guard.admit(meter, 5_000)
    payload = exc.value.payload()
    assert payload["wallet_can_cover"] is True
    # Priced on finishing the run, not just the one call that did not fit.
    assert payload["wallet_satang"] == wallet.satang_for_tokens(20_000 - 1_000)
    assert payload["message"].endswith(guard.WALLET_HINT)


def test_consent_lets_the_balance_extend_the_window():
    quota = _quota(1_000, wallet_satang=100_000, wallet_allowance=100_000)
    assert quota.budget == 1_000 + wallet.tokens_for_satang(100_000)
    meter = _meter(ceiling=500_000, quota=quota, estimate=20_000)
    guard.admit(meter, 5_000)  # the balance carries it: no pause
    assert not meter.stopped


def test_a_chain_step_counts_only_what_it_spends_itself():
    """The snapshot is taken with earlier steps already charged, so the meter
    measures from what it has spent since — not from the run's total."""
    meter = _meter(ceiling=500_000, quota=_quota(10_000), spent=30_000, quota_baseline=30_000)
    guard.admit(meter, 9_000)
    guard.settle_call(meter, 9_000, 9_000)
    with pytest.raises(guard.QuotaExhausted):
        guard.admit(meter, 2_000)


def test_an_optional_call_past_the_quota_is_skipped_not_paused():
    meter = _meter(ceiling=500_000, quota=_quota(100), estimate=20_000)
    with guard.optional_call(), pytest.raises(guard.OptionalCallSkipped):
        guard.admit(meter, 5_000)
    assert not meter.stopped


def test_an_unlimited_run_carries_no_quota():
    run = types.SimpleNamespace(
        id="r", kind="analyze_video", unlimited=True, ceiling_tokens=0, actual_tokens=0,
        media_sec=10.0, precision="standard", estimate_tokens=1_000,
    )
    meter = guard.meter_for_run(run, _quota(0))
    assert meter.quota is None and meter.quota_left() is None
    guard.admit(meter, 10**9)


# ── the gateway asks before every attempt ────────────────────────────────────

async def test_the_gateway_does_not_send_a_call_past_the_ceiling(monkeypatch, quiet_gateway):
    sent = AsyncMock(return_value=_resp())
    monkeypatch.setattr(gw.litellm, "acompletion", sent)
    recorded = AsyncMock(return_value=0)
    monkeypatch.setattr(gw, "record_llm_attempt", recorded)
    with guard.meter_scope(_meter(ceiling=1_000)), pytest.raises(guard.RunBudgetExceeded):
        await gw.acompletion([{"role": "user", "content": "hi"}], model="gemini/gemini-3.7-flash")
    sent.assert_not_awaited()
    recorded.assert_not_awaited()  # nothing reached the vendor, nothing to record


async def test_the_gateway_adds_what_each_call_cost(monkeypatch, quiet_gateway):
    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(return_value=_resp()))
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=7_777))
    meter = _meter(ceiling=200_000)
    with guard.meter_scope(meter):
        await gw.acompletion([{"role": "user", "content": "hi"}], model="gemini/gemini-3.7-flash")
        await gw.acompletion([{"role": "user", "content": "hi"}], model="gemini/gemini-3.7-flash")
    assert (meter.spent, meter.in_flight) == (15_554, 0)


async def test_every_retry_is_checked_again(monkeypatch, quiet_gateway):
    """A retry after a billed failure must fit what is left; here it does not."""
    monkeypatch.setattr(gw, "_RETRY_BACKOFF_SEC", 0.0)
    calls = {"n": 0}

    async def flaky(**kwargs):
        calls["n"] += 1
        raise RuntimeError("Error 503 upstream")

    monkeypatch.setattr(gw.litellm, "acompletion", flaky)
    budget = rate_card.tokens_for_llm("gemini-3.7-flash", 1, 0, 8_000)
    # The failed attempt still cost something (the vendor billed its input).
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=budget // 2 + 1))
    meter = _meter(ceiling=budget + budget // 2)
    with guard.meter_scope(meter), pytest.raises(guard.RunBudgetExceeded):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash")
    assert calls["n"] == 1


async def test_billing_input_tokens_never_reaches_the_provider(monkeypatch, quiet_gateway):
    seen: dict = {}

    async def capture(**kwargs):
        seen.update(kwargs)
        return _resp()

    monkeypatch.setattr(gw.litellm, "acompletion", capture)
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=10))
    with guard.meter_scope(_meter(ceiling=10**9)):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash",
                             billing_input_tokens=123)
    assert "billing_input_tokens" not in seen


async def test_a_hard_stopped_breaker_stops_in_flight_work(monkeypatch):
    monkeypatch.setattr(gw, "check_ai_access", AsyncMock())
    monkeypatch.setattr(guard, "breaker_hard_stop", AsyncMock(return_value=True))
    sent = AsyncMock(return_value=_resp())
    monkeypatch.setattr(gw.litellm, "acompletion", sent)
    with guard.meter_scope(_meter()), pytest.raises(guard.ServicePaused):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash")
    sent.assert_not_awaited()
    # An unlimited (admin) run is never paused.
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=1))
    with guard.meter_scope(_meter(ceiling=None, unlimited=True)):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash")


async def test_the_gateway_waits_for_a_vendor_slot(monkeypatch, quiet_gateway):
    monkeypatch.setattr(gw.litellm, "acompletion", AsyncMock(return_value=_resp()))
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=1))
    acquire = AsyncMock()
    with patch.object(gw.vendor_limits, "acquire_gemini", acquire):
        await gw.acompletion([{"role": "user", "content": "x" * 300}], model="gemini/gemini-3.7-flash")
    acquire.assert_awaited_once()
    assert acquire.await_args.args == ("gemini/gemini-3.7-flash", 100)


# ── speech-to-text, one file at a time ───────────────────────────────────────

def _measured(seconds: float):
    from packages.video.ffmpeg_bin import MediaMeasure

    return lambda p: MediaMeasure(seconds, 0, 0)


async def test_a_transcription_file_past_the_ceiling_is_not_sent(monkeypatch):
    monkeypatch.setattr(guard, "breaker_hard_stop", AsyncMock(return_value=False))
    monkeypatch.setattr("packages.video.ffmpeg_bin.measure_media", _measured(100.0))
    meter = _meter(ceiling=rate_card.tokens_for_stt(150))
    with guard.meter_scope(meter):
        await guard.before_stt_clip(0, Path("a.wav"))
        guard.after_stt_clip(rate_card.tokens_for_stt(100))
        with pytest.raises(guard.RunBudgetExceeded):
            await guard.before_stt_clip(1, Path("b.wav"))
    assert meter.spent == rate_card.tokens_for_stt(100) and meter.in_flight == 0


async def test_run_transcription_calls_the_hooks_before_each_file(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager

    from packages.video import elevenlabs_stt

    order: list[str] = []

    async def fake_clip(wav, keyterms, diarize=None):
        order.append(f"send:{wav.name}")
        return {"audio_duration_secs": 1.0, "words": [], "text": ""}

    async def before(idx, wav):
        order.append(f"guard:{idx}")
        if idx == 1:
            raise guard.RunBudgetExceeded("r")

    @asynccontextmanager
    async def slot():
        order.append("slot")
        yield

    monkeypatch.setattr(elevenlabs_stt, "transcribe_clip", fake_clip)
    monkeypatch.setattr("packages.video.ffmpeg_bin.media_duration", lambda p: 1.0)
    monkeypatch.setattr("packages.video.ffmpeg_bin.measure_media", _measured(1.0))
    wavs = [tmp_path / "a.wav", tmp_path / "b.wav"]
    with pytest.raises(guard.RunBudgetExceeded):
        await elevenlabs_stt.run_transcription(wavs, before_clip=before, clip_slot=slot)
    assert order == ["guard:0", "slot", "send:a.wav", "guard:1"]


async def test_an_unmeasurable_wav_is_priced_from_its_size_never_as_zero(monkeypatch, tmp_path):
    """It used to count as 0 s — priced at nothing and sent anyway."""
    monkeypatch.setattr(guard, "breaker_hard_stop", AsyncMock(return_value=False))
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"\0" * 80_000)  # not a WAV ffprobe can read
    assert guard.stt_clip_seconds(wav) == 10.0  # 80 kB ÷ 8 kB/s, the lowest PCM rate
    meter = _meter(ceiling=rate_card.tokens_for_stt(5))
    with guard.meter_scope(meter), pytest.raises(guard.RunBudgetExceeded):
        await guard.before_stt_clip(0, wav)


# ── video parts priced per file, output capped (2026-09-22 review) ──────────

def test_video_is_priced_from_the_seconds_the_call_attaches():
    """Every attached file counts — not the run total once per call."""
    meter = _meter(media_input_tokens=1_000)
    video = [{"role": "user", "content": [{"type": "file", "file": {"file_id": f, "format": "video/mp4"}}
                                          for f in ("a", "b")]}]
    assert guard.input_budget(meter, video, video_sec=90.0) == 90 * 100
    assert guard.input_budget(meter, video, video_sec=90.0, video_precision="high") == 90 * 300
    assert guard.input_budget(meter, video) == 1_000  # no hint: the run's own estimate


async def test_the_admission_caps_output_at_what_the_run_can_still_afford(monkeypatch):
    monkeypatch.setattr(guard, "breaker_hard_stop", AsyncMock(return_value=False))
    msgs = [{"role": "user", "content": "x" * 3_000}]  # 1,000 input tokens
    meter = _meter(ceiling=100_000, spent=10_000)
    with guard.meter_scope(meter):
        adm = await guard.before_llm_call("gemini/gemini-3.7-flash", msgs, {})
    rate = rate_card.card().llm["flash"]
    assert adm.max_tokens == int((100_000 - 10_000 - 1_000 * rate.input) // rate.output)
    assert adm.max_tokens >= 8_000  # never below the profile the estimate used
    assert adm.input_tokens == 1_000 and adm.input_charge == rate_card.tokens_for_llm("flash", 1_000, 0, 0)
    with guard.meter_scope(_meter(ceiling=100_000)):
        own = await guard.before_llm_call("gemini/gemini-3.7-flash", msgs, {"max_tokens": 500})
    assert own.max_tokens is None  # the call site's own cap stands
    with guard.meter_scope(_meter(ceiling=None, unlimited=True)):
        free = await guard.before_llm_call("gemini/gemini-3.7-flash", msgs, {})
    assert free.max_tokens is None


def test_a_truncated_answer_stops_the_run_or_skips_an_optional_call():
    meter = _meter()
    with guard.meter_scope(meter), guard.optional_call(), pytest.raises(guard.OptionalCallSkipped):
        guard.output_truncated()
    assert not meter.stopped
    with guard.meter_scope(meter), pytest.raises(guard.RunBudgetExceeded):
        guard.output_truncated()
    assert meter.stopped


def _length_resp():
    usage = types.SimpleNamespace(prompt_tokens=1_000, completion_tokens=9_000, total_tokens=10_000)
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(
            message=types.SimpleNamespace(content='{"segm', tool_calls=None), finish_reason="length",
        )],
        usage=usage,
    )


async def test_the_gateway_sends_the_cap_and_treats_a_cut_off_answer_as_a_limit_stop(monkeypatch, quiet_gateway):
    seen: list[dict] = []

    async def capture(**kwargs):
        seen.append(dict(kwargs))
        return _length_resp()

    monkeypatch.setattr(gw.litellm, "acompletion", capture)
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=50_000))
    meter = _meter(ceiling=100_000)
    with guard.meter_scope(meter), pytest.raises(guard.RunBudgetExceeded):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash")
    assert seen[0]["max_tokens"] >= 8_000 and meter.stopped and meter.spent == 50_000
    # A call site's own max_tokens is sent as is and a "length" finish is its business.
    seen.clear()
    with guard.meter_scope(_meter(ceiling=100_000)):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash", max_tokens=64)
    assert seen[0]["max_tokens"] == 64


async def test_a_retry_after_a_timeout_counts_the_timed_out_input(monkeypatch, quiet_gateway):
    """The vendor may bill a request that timed out; the retry must not be
    admitted at the full budget as if it never happened."""
    monkeypatch.setattr(gw, "_RETRY_BACKOFF_SEC", 0.0)
    attempts = iter([gw.asyncio.TimeoutError(), _resp()])

    async def flaky(**kwargs):
        item = next(attempts)
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(gw.litellm, "acompletion", flaky)
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=0))
    meter = _meter(ceiling=10**9)
    with guard.meter_scope(meter):
        await gw.acompletion([{"role": "user", "content": "x" * 3_000}], model="gemini/gemini-3.7-flash")
    assert meter.spent == rate_card.tokens_for_llm("flash", 1_000, 0, 0)


async def test_a_cancelled_attempt_is_recorded_before_the_cancel_goes_on(monkeypatch, quiet_gateway):
    async def hangs(**kwargs):
        raise gw.asyncio.CancelledError()

    monkeypatch.setattr(gw.litellm, "acompletion", hangs)
    recorded = AsyncMock(return_value=1_234)
    monkeypatch.setattr(gw, "record_llm_attempt", recorded)
    meter = _meter(ceiling=10**9)
    with guard.meter_scope(meter), pytest.raises(gw.asyncio.CancelledError):
        await gw.acompletion([{"role": "user", "content": "x" * 3_000}], model="gemini/gemini-3.7-flash")
    kw = recorded.await_args.kwargs
    assert kw["status"] == "cancelled" and kw["input_tokens"] == 1_000
    assert (meter.spent, meter.in_flight) == (1_234, 0)


async def test_a_cancelled_stream_records_what_it_already_streamed(monkeypatch, quiet_gateway):
    async def dying_stream(**kwargs):
        async def gen():
            yield types.SimpleNamespace(
                choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="x"))],
                usage=types.SimpleNamespace(prompt_tokens=5_000, completion_tokens=40, total_tokens=5_040),
            )
            raise gw.asyncio.CancelledError()

        return gen()

    monkeypatch.setattr(gw.litellm, "acompletion", dying_stream)
    recorded = AsyncMock(return_value=10)
    monkeypatch.setattr(gw, "record_llm_attempt", recorded)
    with guard.meter_scope(_meter(ceiling=10**9)), pytest.raises(gw.asyncio.CancelledError):
        await gw.acompletion_stream_thinking(
            [{"role": "user", "content": "hi"}], project_uid="p", model="gemini/gemini-3.8-flash"
        )
    kw = recorded.await_args.kwargs
    assert (kw["status"], kw["input_tokens"], kw["output_tokens"]) == ("cancelled", 5_000, 40)


async def test_billing_video_hints_never_reach_the_provider(monkeypatch, quiet_gateway):
    seen: dict = {}

    async def capture(**kwargs):
        seen.update(kwargs)
        return _resp()

    monkeypatch.setattr(gw.litellm, "acompletion", capture)
    monkeypatch.setattr(gw, "record_llm_attempt", AsyncMock(return_value=10))
    with guard.meter_scope(_meter(ceiling=10**9)):
        await gw.acompletion([{"role": "user", "content": "h"}], model="gemini/gemini-3.7-flash",
                             billing_video_sec=12.0, billing_video_precision="high")
    assert not any(k.startswith("billing_") for k in seen)


# ── layer 3: the circuit breaker (real DB) ───────────────────────────────────

async def _set_breaker(**value):
    from packages.db.session import get_sessionmaker

    async with get_sessionmaker()() as s:
        from sqlalchemy import text

        await s.execute(text("SET search_path TO core, public"))
        before = await guard.load_breaker(s)
        await guard.save_breaker(s, value, None)
        await s.commit()
    return before


async def test_the_breaker_opens_at_the_cap_and_hard_stops_above_it(monkeypatch):
    before = await _set_breaker(enabled=True, daily_cap_thb=10**9, hard_stop_ratio=1.25)
    try:
        assert await guard.breaker_open() is False and await guard.breaker_hard_stop() is False
        # Today's spend as the dev DB has it, then a cap just under / around it.
        monkeypatch.setattr(guard, "spend_on", AsyncMock(return_value=100.0))
        await _set_breaker(enabled=True, daily_cap_thb=90.0, hard_stop_ratio=1.25)
        alerts = AsyncMock()
        monkeypatch.setattr(guard, "_alert_once", alerts)
        assert await guard.breaker_open() is True
        assert await guard.breaker_hard_stop() is False  # 100 < 90 × 1.25
        await _set_breaker(enabled=True, daily_cap_thb=50.0, hard_stop_ratio=1.25)
        assert await guard.breaker_hard_stop() is True
        await _set_breaker(enabled=False, daily_cap_thb=50.0, hard_stop_ratio=1.25)
        assert await guard.breaker_open() is False
        assert alerts.await_count == 1
        status = await guard.status()
        assert status["spend_today_thb"] == 100.0 and status["tripped"] is False and status["enabled"] is False
    finally:
        await _set_breaker(**before)


async def test_the_trip_alert_is_sent_once_per_day(monkeypatch):
    claims = iter([True, False])
    monkeypatch.setattr(guard, "_claim_alert", AsyncMock(side_effect=lambda day: next(claims)))
    mailed = AsyncMock()
    monkeypatch.setattr(guard, "_email_admins", mailed)
    config = guard.normalize_breaker({"daily_cap_thb": 10})
    await guard._alert_once(config, 12.5)
    await guard._alert_once(config, 13.0)
    assert mailed.await_count == 1
    rows = await db(
        "SELECT detail FROM core.admin_audit_events WHERE action = 'circuit_breaker_tripped' ORDER BY id DESC LIMIT 1"
    )
    assert rows[0][0]["spend_thb"] == 12.5
    await db("DELETE FROM core.admin_audit_events WHERE action = 'circuit_breaker_tripped' AND actor_user_id IS NULL "
             "AND (detail->>'spend_thb')::numeric = 12.5")
