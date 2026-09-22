"""LOADTEST_FAKE_AI: every real AI caller parses the fake answers, and the
production guard refuses to load fake mode.

Each caller test runs the REAL call-site function (prompt building, gateway,
guard, parser, normaliser) — only the vendor round trip is faked. No test here
reaches a vendor: fake mode short-circuits before litellm/httpx, and the API
keys are blanked so a leak would fail rather than bill.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from packages.core.settings import FakeAIInProduction, Settings, get_settings
from tests.media_helpers import video_bytes, wav_bytes


@pytest.fixture
def fake_on(monkeypatch):
    for var in ("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "ENVIRONMENT", "APP_ENV"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LOADTEST_FAKE_AI", "1")
    monkeypatch.setenv("LOADTEST_FAKE_AI_DELAY_SEC", "0")
    monkeypatch.setenv("LOADTEST_FAKE_STT_DELAY_SEC", "0")
    monkeypatch.setenv("LOADTEST_FAKE_UPLOAD_SEC", "0")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    get_settings.cache_clear()

    import litellm

    async def _no_vendor(*_a, **_k):
        raise AssertionError("fake mode reached litellm")

    monkeypatch.setattr(litellm, "acompletion", _no_vendor)
    monkeypatch.setattr(litellm, "acreate_file", _no_vendor)
    monkeypatch.setattr(litellm, "afile_delete", _no_vendor)
    yield
    get_settings.cache_clear()


@pytest.fixture
def clips(tmp_path: pathlib.Path) -> list[tuple[str, pathlib.Path, float]]:
    out = []
    for i, sec in enumerate((8.0, 6.0)):
        p = tmp_path / f"proxy_{i:03d}.mp4"
        p.write_bytes(video_bytes(sec))
        out.append((f"clip{i}", p, sec))
    return out


# ── production guard ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("var", "value"),
    [
        ("RAILWAY_ENVIRONMENT_NAME", "production"),
        ("RAILWAY_ENVIRONMENT", "production"),
        ("ENVIRONMENT", "production"),
        ("APP_ENV", "prod"),
        ("RAILWAY_ENVIRONMENT_NAME", "Production"),
    ],
)
def test_settings_refuse_fake_ai_in_production(monkeypatch, var, value):
    monkeypatch.setenv("LOADTEST_FAKE_AI", "1")
    monkeypatch.setenv(var, value)
    with pytest.raises(FakeAIInProduction):
        Settings()


def test_settings_allow_fake_ai_in_loadtest_env(monkeypatch):
    for var in ("RAILWAY_ENVIRONMENT", "ENVIRONMENT", "APP_ENV"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("LOADTEST_FAKE_AI", "1")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "loadtest")
    assert Settings().loadtest_fake_ai is True


def test_production_without_fake_ai_is_untouched(monkeypatch):
    monkeypatch.delenv("LOADTEST_FAKE_AI", raising=False)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    assert Settings().loadtest_fake_ai is False


def test_startup_and_call_time_recheck_the_environment(fake_on, monkeypatch):
    from packages.core.settings import announce_fake_ai
    from packages.llm import fake

    assert announce_fake_ai() is True
    assert fake.active() is True
    # Settings are cached; the environment turning production afterwards must
    # still refuse at startup AND at every faked call.
    get_settings()
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    with pytest.raises(FakeAIInProduction):
        announce_fake_ai()
    with pytest.raises(FakeAIInProduction):
        fake.active()


def test_off_by_default(monkeypatch):
    monkeypatch.delenv("LOADTEST_FAKE_AI", raising=False)
    get_settings.cache_clear()
    from packages.core.settings import announce_fake_ai
    from packages.llm import fake

    assert announce_fake_ai() is False
    assert fake.active() is False


# ── every caller parses the fake answers ─────────────────────────────────────


async def test_dub_edit_script_video(fake_on, clips):
    from packages.video.dub_ai import generate_dub_edit_script_video

    thoughts: list[str] = []

    async def on_thinking(text: str) -> None:
        thoughts.append(text)

    script = await generate_dub_edit_script_video(
        clips, brief="", user_script="", target_duration_sec=None, project_uid="lt",
        on_thinking=on_thinking,
    )
    segs = script["segments"]
    assert len(segs) >= 4
    bounds = {c: d for c, _p, d in clips}
    for s in segs:
        assert 0 <= s["sourceIn"] < s["sourceOut"] <= bounds[s["sourceClip"]]
        assert s["voiceoverLineId"] >= 1
    assert any(s.get("alternates") for s in segs)
    assert thoughts, "streamed thinking reaches on_thinking"


async def test_dub_reedit_scoped(fake_on, clips, tmp_path):
    from packages.video.dub_ai import (
        generate_dub_edit_script_video,
        generate_dub_reedit_script_video,
    )

    script = await generate_dub_edit_script_video(
        clips, brief="", user_script="", target_duration_sec=None, project_uid="lt",
    )
    preview = tmp_path / "preview.mp4"
    preview.write_bytes(video_bytes(5.0))
    out = await generate_dub_reedit_script_video(
        clips, (preview, 5.0),
        current_segments=script["segments"], selected_line_ids=[1],
        instruction="เปลี่ยนมุม", project_uid="lt",
    )
    assert out and all(s["voiceoverLineId"] == 1 for s in out)


async def test_dub_timeline_plan(fake_on):
    from packages.video.dub_ai import plan_dub_timeline_cuts

    script = {"segments": [
        {"order": i, "voiceoverLineId": i, "sourceClip": "clip0", "sourceIn": i * 1.5,
         "sourceOut": i * 1.5 + 1.4, "durationSec": 1.4}
        for i in range(4)
    ]}
    cuts = await plan_dub_timeline_cuts(script, vo_duration=8.0, clip_durations=[8.0])
    assert cuts


async def test_frames_edit_script(fake_on, tmp_path):
    from packages.video.dub_ai import generate_dub_edit_script

    frames = []
    for i, t in enumerate((0.5, 2.0, 3.5, 5.0)):
        jpg = tmp_path / f"f{i}.jpg"
        jpg.write_bytes(b"\xff\xd8\xff\xd9")
        frames.append({"clip_id": "clip0", "time": t, "frame_path": str(jpg), "edge": "requested"})
    script = await generate_dub_edit_script(
        frames, brief="", user_script="", target_duration_sec=None, project_uid="lt",
    )
    assert script["segments"]


def _transcript(n: int) -> list[dict]:
    return [
        {"start": i * 2.0, "end": i * 2.0 + 1.6, "text": f"ประโยคที่ {i}",
         "words": [{"word": f"ประโยคที่ {i}", "start": i * 2.0, "end": i * 2.0 + 1.6}]}
        for i in range(n)
    ]


async def test_speech_scenes(fake_on):
    from packages.video.speech_select import select_scenes

    picks = await select_scenes(_transcript(12), project_uid="lt")
    assert picks and all(0 <= p["segFrom"] <= p["segTo"] < 12 for p in picks)


async def test_speech_highlights_with_trim(fake_on):
    from packages.video.speech_select import select_highlights

    picks = await select_highlights(_transcript(12), source_duration=24.0, project_uid="lt")
    assert picks and all(p["cuts"] for p in picks)


async def test_effects_placement(fake_on, tmp_path):
    from packages.video.effects_ai import generate_effects_placement

    cut = tmp_path / "cut.mp4"
    cut.write_bytes(video_bytes(6.0))
    doc = await generate_effects_placement(cut, project_uid="lt", cut_points_sec=[2.0, 4.0])
    assert doc["instances"]


async def test_effects_style_distill(fake_on):
    from packages.video.effects_style import distill_style_prompt

    guide = await distill_style_prompt(None, "ซูมเข้าช้า ๆ บ่อย ๆ", project_uid="lt")
    assert guide.strip()


async def test_cut_style_distill(fake_on):
    from packages.video.cut_style import distill_cut_style_prompt

    guide = await distill_cut_style_prompt(None, "ตัดเร็ว หลายมุม", project_uid="lt")
    assert guide.strip()


async def test_transcription(fake_on, tmp_path):
    from packages.video.elevenlabs_stt import run_transcription

    wav = tmp_path / "a.wav"
    wav.write_bytes(wav_bytes(10.0))
    billed: list[float] = []

    async def on_billed(_idx: int, sec: float, _kt: bool) -> None:
        billed.append(sec)

    out = await run_transcription([wav], project_uid="lt", on_clip_billed=on_billed)
    assert out is not None and out["segments"]
    assert len(out["segments"]) >= 2, "the fake speech has real pauses to cut on"
    assert billed and abs(billed[0] - 10.0) < 0.1


async def test_usage_is_realistic_and_capped(fake_on):
    from packages.llm import fake

    kwargs = {
        "model": "gemini/gemini-3.1-pro-preview", "stream": False, "max_tokens": 1000,
        "messages": [{"role": "user", "content": "hi"}],
    }
    resp = await fake.acompletion(kwargs, input_estimate=40_000)
    assert 36_000 <= resp.usage.prompt_tokens <= 43_000
    assert resp.usage.completion_tokens < 1000
    assert json.dumps(resp.choices[0].message.content)
