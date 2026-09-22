"""Per-user speech-to-text accounting.

The ElevenLabs key is one shared account, so account-level totals are every
user's usage combined and must never be reported to an individual. The only
correct source is our own ledger, filled from what each run was billed for.
"""

import asyncio
import pathlib


def test_run_transcription_reports_the_billable_audio_length(monkeypatch) -> None:
    """Scribe returns no price, but it does return what it billed on."""
    from packages.video import elevenlabs_stt as stt

    async def fake_transcribe(wav, keyterms, *, diarize=None):  # noqa: ANN001, ARG001
        # Shape per the official convert-endpoint docs: audio_duration_secs is
        # present, and there is no cost or credit field to read.
        return {"words": [], "text": "", "audio_duration_secs": 12.5}

    monkeypatch.setattr(stt, "transcribe_clip", fake_transcribe)
    monkeypatch.setattr(
        "packages.video.ffmpeg_bin.media_duration", lambda p: 12.5, raising=False
    )

    result = asyncio.run(
        stt.run_transcription([pathlib.Path("a.wav"), pathlib.Path("b.wav")])
    )
    assert result is not None
    assert result["billed_audio_sec"] == 25.0


def test_billable_length_survives_a_reply_without_the_field(monkeypatch) -> None:
    from packages.video import elevenlabs_stt as stt

    async def fake_transcribe(wav, keyterms, *, diarize=None):  # noqa: ANN001, ARG001
        return {"words": [], "text": ""}

    monkeypatch.setattr(stt, "transcribe_clip", fake_transcribe)
    monkeypatch.setattr(
        "packages.video.ffmpeg_bin.media_duration", lambda p: 3.0, raising=False
    )

    result = asyncio.run(stt.run_transcription([pathlib.Path("a.wav")]))
    assert result is not None
    # Unknown is reported as zero rather than guessed from the WAV — an
    # invented figure would be billed to a user who never incurred it.
    assert result["billed_audio_sec"] == 0.0


def test_record_stt_usage_ignores_a_zero_length_run() -> None:
    """No row for nothing transcribed — and no DB hit to find that out."""
    from packages.llm.usage import UsageCtx, record_stt_usage

    ctx = UsageCtx(user_id=1, tenant_id=1, feature="video_cut", reference_id="p1")
    # Would raise if it tried to open a session (no DB configured in tests).
    asyncio.run(record_stt_usage(ctx, 0.0))
    asyncio.run(record_stt_usage(ctx, -5.0))


def test_stt_usage_log_is_scoped_to_a_user() -> None:
    """The ledger must carry the user, or attribution is impossible."""
    from packages.db.models.stt_usage import SttUsageLog

    cols = SttUsageLog.__table__.columns
    assert "user_id" in cols
    assert "tenant_id" in cols
    assert not cols["user_id"].nullable
    assert SttUsageLog.__table__.schema == "core"


def test_credit_rates_match_the_measured_account_deltas() -> None:
    """Two live probes on 2026-08-12: 5s cost 6 credits, 17s cost 19."""
    from packages.video.stt_pricing import credits_for

    assert credits_for(5.0, "scribe_v2") == 6
    assert credits_for(17.0, "scribe_v2") == 19


def test_the_expensive_model_is_priced_as_such() -> None:
    """scribe_v2_5 measured at ~12.5x scribe_v2 per second — the single
    biggest lever on speech-to-text cost."""
    from packages.video.stt_pricing import credits_for

    cheap = credits_for(60.0, "scribe_v2")
    dear = credits_for(60.0, "scribe_v2_5")
    assert cheap == 67  # 4000 credits/hour
    assert dear == 834  # 50000 credits/hour
    assert dear > cheap * 12


def test_an_unmeasured_model_is_priced_high_not_cheap() -> None:
    """An under-estimate would read as 'nearly free' — the wrong way to be wrong."""
    from packages.video.stt_pricing import credits_for, is_rate_known

    assert not is_rate_known("scribe_v9")
    assert credits_for(60.0, "scribe_v9") == credits_for(60.0, "scribe_v2_5")
    # Rows written before the model column existed land here too.
    assert credits_for(60.0, "") == credits_for(60.0, "scribe_v2_5")


def test_zero_length_costs_nothing() -> None:
    from packages.video.stt_pricing import credits_for

    assert credits_for(0.0, "scribe_v2") == 0
    assert credits_for(-1.0, "scribe_v2") == 0


def test_a_run_is_billed_by_the_ceiling() -> None:
    """Every probe showed ElevenLabs charging the ceiling of the fraction."""
    from packages.video.stt_pricing import credits_for

    # 1s at 4000/hour = 1.11 credits.
    assert credits_for(1.0, "scribe_v2") == 2


def test_run_transcription_reports_the_model_it_used(monkeypatch) -> None:
    """Seconds without the model cannot be priced."""
    from packages.core.settings import get_settings
    from packages.video import elevenlabs_stt as stt

    async def fake_transcribe(wav, keyterms, *, diarize=None):  # noqa: ANN001, ARG001
        return {"words": [], "text": "", "audio_duration_secs": 4.0}

    monkeypatch.setattr(stt, "transcribe_clip", fake_transcribe)
    monkeypatch.setattr(
        "packages.video.ffmpeg_bin.media_duration", lambda p: 4.0, raising=False
    )
    result = asyncio.run(stt.run_transcription([pathlib.Path("a.wav")]))
    assert result is not None
    assert result["stt_model"] == get_settings().elevenlabs_stt_model


def test_each_file_is_reported_as_soon_as_it_is_billed(monkeypatch) -> None:
    """Per-file recording: a run that dies on clip 2 already billed clip 1."""
    from packages.video import elevenlabs_stt as stt

    replies = iter([{"words": [], "text": "", "audio_duration_secs": 7.5}, RuntimeError("Scribe 500")])

    async def fake_transcribe(wav, keyterms, *, diarize=None):  # noqa: ANN001, ARG001
        item = next(replies)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(stt, "transcribe_clip", fake_transcribe)
    monkeypatch.setattr("packages.video.ffmpeg_bin.media_duration", lambda p: 7.5, raising=False)
    billed: list[tuple[int, float, bool]] = []

    async def on_billed(idx: int, sec: float, keyterms: bool) -> None:
        billed.append((idx, sec, keyterms))

    import pytest

    with pytest.raises(RuntimeError):
        asyncio.run(
            stt.run_transcription(
                [pathlib.Path("a.wav"), pathlib.Path("b.wav")],
                keyterms=["Noey", " "],
                on_clip_billed=on_billed,
            )
        )
    assert billed == [(0, 7.5, True)]


def test_blank_keyterms_are_not_a_keyterms_request(monkeypatch) -> None:
    from packages.video import elevenlabs_stt as stt

    async def fake_transcribe(wav, keyterms, *, diarize=None):  # noqa: ANN001, ARG001
        return {"words": [], "text": "", "audio_duration_secs": 2.0}

    monkeypatch.setattr(stt, "transcribe_clip", fake_transcribe)
    monkeypatch.setattr("packages.video.ffmpeg_bin.media_duration", lambda p: 2.0, raising=False)
    billed: list[tuple[int, float, bool]] = []

    async def on_billed(idx: int, sec: float, keyterms: bool) -> None:
        billed.append((idx, sec, keyterms))

    asyncio.run(stt.run_transcription([pathlib.Path("a.wav")], keyterms=["", "  "], on_clip_billed=on_billed))
    assert billed == [(0, 2.0, False)]


def test_the_worker_hook_records_the_clip_against_the_task_context(monkeypatch) -> None:
    from packages.billing import metering
    from packages.core.settings import get_settings
    from packages.llm.usage import UsageCtx, reset_usage_ctx, set_usage_ctx
    from services.worker import tasks

    calls: list[dict] = []

    async def fake(ctx, **kw):  # noqa: ANN001
        calls.append({"ctx": ctx, **kw})
        return 0

    monkeypatch.setattr(metering, "record_stt_clip", fake)
    ctx = UsageCtx(user_id=3, tenant_id=1, feature="video_cut", reference_id="p", job_id="vlocal_x")
    token = set_usage_ctx(ctx)
    try:
        asyncio.run(tasks._record_stt_clip(1, 12.0, True))
    finally:
        reset_usage_ctx(token)
    assert calls == [
        {"ctx": ctx, "clip_index": 1, "billed_sec": 12.0,
         "model": get_settings().elevenlabs_stt_model, "keyterms": True}
    ]
