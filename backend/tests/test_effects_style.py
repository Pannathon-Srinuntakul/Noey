"""Style distillation + style-prompt splicing into the effects placement pass."""

from __future__ import annotations

import json
from typing import Any

import pytest

from packages.video import effects_ai, effects_style


_SAMPLE_OBS = {
    "captionVoice": "Calm first-person product showcase, no hype.",
    "onScreenText": {"cadence": "almost-never", "notes": "No intentional captions."},
    "decorativeEffects": {"cadence": "almost-never", "notes": "Raw footage only."},
    "hardCutReframes": {"cadence": "most-scenes", "notes": "Wide to mid hard cuts."},
    "pushZoomHolds": {"cadence": "almost-never", "notes": ""},
    "ambientDrift": {"cadence": "almost-never", "notes": ""},
    "transitions": {"cadence": "almost-never", "notes": "Plain hard cuts."},
    "fontMood": "",
    "openObservations": ["Soft indoor daylight grade."],
}


def _patch_gemini(monkeypatch: pytest.MonkeyPatch, *, content: str, uploaded: list[str] | None = None) -> None:
    async def fake_upload(path, *, mime_type="video/mp4"):
        if uploaded is not None:
            uploaded.append(path.name)
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        class _Msg:
            pass

        _Msg.content = content

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})


# ── format_style_guide ───────────────────────────────────────────────────────

def test_format_style_guide_includes_checklist_and_open_notes() -> None:
    guide = effects_style.format_style_guide(_SAMPLE_OBS)
    assert "Calm first-person" in guide
    assert "cadence almost-never" in guide  # on-screen text
    assert "Hard-cut reframes" in guide and "most-scenes" in guide
    assert "Push/zoom-holds" in guide
    assert "Soft indoor daylight grade." in guide


def test_style_observation_schema_requires_checklist_and_open_field() -> None:
    req = set(effects_style.STYLE_OBSERVATION_SCHEMA["required"])
    assert "openObservations" in req
    assert "hardCutReframes" in req
    assert "pushZoomHolds" in req
    keys = {k for k, _ in effects_style.STYLE_AXES_LIST}
    assert keys <= set(effects_style.STYLE_OBSERVATION_SCHEMA["properties"])


# ── distill_style_prompt ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_distill_with_reference_uploads_and_returns_prose(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    ref = tmp_path / "ref.mp4"
    ref.write_bytes(b"fake")
    uploaded: list[str] = []
    _patch_gemini(monkeypatch, content=json.dumps(_SAMPLE_OBS), uploaded=uploaded)

    guide = await effects_style.distill_style_prompt(ref, "hyped teen seller", project_uid="s1")

    assert "Hard-cut reframes" in guide
    assert "most-scenes" in guide
    assert "ref.mp4" in uploaded  # reference actually uploaded to Gemini


@pytest.mark.asyncio
async def test_distill_description_only_skips_video_upload(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    uploaded: list[str] = []
    obs = {**_SAMPLE_OBS, "captionVoice": "Calm reviewer voice."}
    _patch_gemini(monkeypatch, content=json.dumps(obs), uploaded=uploaded)

    guide = await effects_style.distill_style_prompt(None, "calm reviewer", project_uid="s1")

    assert "Calm reviewer voice." in guide
    assert uploaded == []  # nothing uploaded when no reference clip


@pytest.mark.asyncio
async def test_distill_requires_reference_or_description(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_gemini(monkeypatch, content=json.dumps(_SAMPLE_OBS))
    with pytest.raises(ValueError):
        await effects_style.distill_style_prompt(None, "", project_uid="s1")


@pytest.mark.asyncio
async def test_distill_empty_prose_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_gemini(monkeypatch, content="   ")
    with pytest.raises(RuntimeError):
        await effects_style.distill_style_prompt(None, "some style", project_uid="s1")


@pytest.mark.asyncio
async def test_distill_passes_json_schema_response_format(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return "gemini-file://x"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["kwargs"] = kwargs
        captured["system"] = system

        class _Msg:
            content = json.dumps(_SAMPLE_OBS)

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})

    await effects_style.distill_style_prompt(None, "x", project_uid="s1")

    rf = captured["kwargs"]["response_format"]
    assert rf["type"] == "json_schema"
    assert rf["response_schema"]["required"][-1] == "openObservations"
    assert "style_axes_checklist" in captured["system"]
    assert "openObservations" in captured["system"]


# ── style_prompt splice into generate_effects_placement ──────────────────────

def _patch_placement(monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]) -> None:
    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["system"] = system

        class _Msg:
            content = json.dumps({
                "catalogPlacements": [], "customEffects": [],
                "zoomPunches": [], "transitions": [], "sceneDrifts": [],
            })

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})
    monkeypatch.setattr("packages.video.ffmpeg_bin.media_duration", lambda path: 20.0)


@pytest.mark.asyncio
async def test_style_prompt_spliced_as_style_block(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    captured: dict[str, Any] = {}
    _patch_placement(monkeypatch, captured)

    await effects_ai.generate_effects_placement(
        video, project_uid="p1",
        style_prompt="ONLY plain captions, zero decorative effects, no synthetic zoom.",
    )

    sys = captured["system"]
    assert "<style>" in sys
    assert "ONLY plain captions, zero decorative effects" in sys
    assert "__STYLE_BLOCK__" not in sys  # token was substituted


@pytest.mark.asyncio
async def test_no_style_prompt_omits_style_block(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    captured: dict[str, Any] = {}
    _patch_placement(monkeypatch, captured)

    await effects_ai.generate_effects_placement(video, project_uid="p1")

    sys = captured["system"]
    assert "<style>" not in sys
    assert "__STYLE_BLOCK__" not in sys  # token substituted with empty string


# ── router + task wiring ─────────────────────────────────────────────────────

def test_effect_styles_router_registers_crud_routes() -> None:
    from services.api.routers import effect_styles

    paths = {r.path for r in effect_styles.router.routes}
    assert "/effect-styles" in paths
    assert "/effect-styles/{uid}" in paths
    assert "/effect-styles/{uid}/regenerate" in paths


def test_distill_style_task_registered() -> None:
    import services.worker.tasks as tasks

    assert hasattr(tasks, "distill_style_local")
    names = {getattr(f, "__name__", "") for f in tasks.WorkerSettings.functions}
    assert "distill_style_local" in names
