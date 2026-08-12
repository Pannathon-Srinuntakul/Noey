"""Cut-style distillation (packages/video/cut_style.py) + splice into the dub
edit prompts (dub_ai.apply_cut_style). Mirrors the harness style of
tests/test_effects_style.py — Gemini transport fully mocked."""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from packages.core.settings import get_settings
from packages.video import cut_style, dub_ai


_SAMPLE_OBS = {
    "hookStructure": "Opens on a fast product reveal with two cuts in the first 2s.",
    "shotLengthRhythm": "Burst-then-breathe: rapid flurries settling into short holds.",
    "multiAngleVsHeld": {"cadence": "most-scenes", "notes": "Angle flips inside each beat."},
    "punchInsCameraMove": {"cadence": "some-scenes", "notes": ""},
    "brollProductInserts": {"cadence": "rare", "notes": "One close-up insert."},
    "pacingCurve": "Front-loaded chaos, settles mid-video.",
    "sceneOrderStory": "Hook, demo, CTA.",
    "musicSyncBehavior": {"cadence": "almost-never", "notes": ""},
    "endingCta": "Hard stop on a camera-facing shot.",
    "openObservations": ["Jump-cuts inside a single angle."],
}

_FIXED_STATS = {
    "duration_sec": 12.0,
    "shot_count": 5,
    "cut_count": 4,
    "cuts_per_minute": 20.0,
    "avg_shot_sec": 2.4,
    "median_shot_sec": 1.5,
    "min_shot_sec": 0.4,
    "max_shot_sec": 6.3,
    "histogram": {"under_0_5s": 1, "s0_5_to_1": 1, "s1_to_2": 1, "s2_to_4": 1, "over_4s": 1},
    "cuts_per_minute_by_third": [45.0, 15.0, 0.0],
}


def _patch_gemini(
    monkeypatch: pytest.MonkeyPatch,
    *,
    content: str,
    uploaded: list[str] | None = None,
    deleted: list[list[str]] | None = None,
    captured: dict[str, Any] | None = None,
    stream_error: Exception | None = None,
) -> None:
    async def fake_upload(path, *, mime_type="video/mp4"):
        if uploaded is not None:
            uploaded.append(path.name)
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        if deleted is not None:
            deleted.append(file_ids)

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        if captured is not None:
            captured["messages"] = messages
            captured["system"] = system
            captured["kwargs"] = kwargs
        if stream_error is not None:
            raise stream_error

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
    monkeypatch.setattr(
        "packages.llm.config.call_kwargs",
        lambda model=None, effort=None: {"model": model, "effort": effort},
    )


# ── axes / schema parity ─────────────────────────────────────────────────────

def test_cut_axes_match_observation_schema() -> None:
    keys = [k for k, _ in cut_style.CUT_AXES_LIST]
    assert len(keys) == 9
    props = set(cut_style.CUT_OBSERVATION_SCHEMA["properties"])
    required = set(cut_style.CUT_OBSERVATION_SCHEMA["required"])
    for key in keys:
        assert key in props, f"{key} missing from schema properties"
        assert key in required, f"{key} missing from schema required"
    assert "openObservations" in props
    assert "openObservations" in required


# ── compute_cut_stats ────────────────────────────────────────────────────────

def test_compute_cut_stats_math(monkeypatch: pytest.MonkeyPatch) -> None:
    scenes = [
        {"start": 0.0, "end": 0.4, "duration": 0.4},
        {"start": 0.4, "end": 1.2, "duration": 0.8},
        {"start": 1.2, "end": 2.7, "duration": 1.5},
        {"start": 2.7, "end": 5.7, "duration": 3.0},
        {"start": 5.7, "end": 12.0, "duration": 6.3},
    ]
    monkeypatch.setattr("packages.video.scene.detect_scenes", lambda path: scenes)

    stats = cut_style.compute_cut_stats(pathlib.Path("ref.mp4"))

    assert stats is not None
    assert stats["duration_sec"] == 12.0
    assert stats["shot_count"] == 5
    assert stats["cut_count"] == 4
    assert stats["cuts_per_minute"] == 20.0  # 4 cuts / 0.2 min
    assert stats["avg_shot_sec"] == 2.4
    assert stats["median_shot_sec"] == 1.5
    assert stats["min_shot_sec"] == 0.4
    assert stats["max_shot_sec"] == 6.3
    assert stats["histogram"] == {
        "under_0_5s": 1, "s0_5_to_1": 1, "s1_to_2": 1, "s2_to_4": 1, "over_4s": 1,
    }
    # thirds are 4s each; cut points at 0.4/1.2/2.7 land in the first third,
    # 5.7 in the second, none in the last → 3, 1, 0 cuts per 4s ⇒ per minute:
    assert stats["cuts_per_minute_by_third"] == [45.0, 15.0, 0.0]


def test_compute_cut_stats_returns_none_on_detect_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(path):
        raise RuntimeError("scenedetect exploded")

    monkeypatch.setattr("packages.video.scene.detect_scenes", boom)
    assert cut_style.compute_cut_stats(pathlib.Path("ref.mp4")) is None


def test_compute_cut_stats_skips_non_video_without_detecting(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Any] = []
    monkeypatch.setattr("packages.video.scene.detect_scenes", lambda path: calls.append(path) or [])

    assert cut_style.compute_cut_stats(pathlib.Path("ref.jpg")) is None
    assert calls == []  # suffix gate fires before scene detection


def test_compute_cut_stats_returns_none_on_empty_scenes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("packages.video.scene.detect_scenes", lambda path: [])
    assert cut_style.compute_cut_stats(pathlib.Path("ref.mp4")) is None


# ── format_cut_stats_text / format_cut_style_guide ───────────────────────────

def test_format_cut_stats_text_renders_measurements() -> None:
    text = cut_style.format_cut_stats_text(_FIXED_STATS)
    assert text.startswith("<measured_cut_stats>")
    assert text.endswith("</measured_cut_stats>")
    assert "cuts/min: 20.0" in text
    assert "<0.5s: 1" in text
    assert "45.0 / 15.0 / 0.0" in text


def test_format_cut_style_guide_full_observation() -> None:
    guide = cut_style.format_cut_style_guide(_SAMPLE_OBS)
    assert "Hook (first 1-3s): Opens on a fast product reveal" in guide
    assert "Burst-then-breathe" in guide
    assert "Multi-angle flashes vs held shots: cadence most-scenes." in guide
    assert "Angle flips inside each beat." in guide
    assert "B-roll / product inserts: cadence rare." in guide
    assert "Pacing curve: Front-loaded chaos" in guide
    assert "Ending: Hard stop on a camera-facing shot." in guide
    assert "Also observe: Jump-cuts inside a single angle." in guide
    assert "Measured rhythm" not in guide  # no stats given


def test_format_cut_style_guide_defaults_on_missing_axes() -> None:
    guide = cut_style.format_cut_style_guide({})
    assert "Open on the strongest visual moment available." in guide
    assert "Keep a steady short-form rhythm." in guide
    assert "Multi-angle flashes vs held shots: cadence most-scenes." in guide
    assert "Punch-ins / camera moves across cuts: cadence some-scenes." in guide
    assert "Hook first, then demonstrate, then close." in guide
    assert "Close on a clear final shot." in guide
    assert "Also observe:" not in guide
    assert "Measured rhythm" not in guide


def test_format_cut_style_guide_appends_measured_rhythm_iff_stats() -> None:
    guide = cut_style.format_cut_style_guide(_SAMPLE_OBS, _FIXED_STATS)
    assert "Measured rhythm from the reference:" in guide
    assert "~20.0 cuts/min" in guide
    assert "median shot 1.5s" in guide
    assert "45.0 / 15.0 / 0.0 cuts/min (start/middle/end)" in guide


# ── distill_cut_style_prompt assembly ────────────────────────────────────────

async def test_distill_assembly_with_reference_and_platform(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    ref = tmp_path / "ref.mp4"
    ref.write_bytes(b"fake")
    uploaded: list[str] = []
    deleted: list[list[str]] = []
    captured: dict[str, Any] = {}
    _patch_gemini(
        monkeypatch, content=json.dumps(_SAMPLE_OBS),
        uploaded=uploaded, deleted=deleted, captured=captured,
    )
    monkeypatch.setattr(cut_style, "compute_cut_stats", lambda p: dict(_FIXED_STATS))

    guide = await cut_style.distill_cut_style_prompt(
        ref, "fast angle flips", target_platform="tiktok", project_uid="s1",
    )

    # Model + effort + structured output.
    assert captured["kwargs"]["model"] == f"gemini/{get_settings().dub_vision_model}"
    assert captured["kwargs"]["effort"] == "high"
    rf = captured["kwargs"]["response_format"]
    assert rf["type"] == "json_schema"
    assert rf["response_schema"] == cut_style.CUT_OBSERVATION_SCHEMA
    assert "cut_axes_checklist" in captured["system"]
    assert "openObservations" in captured["system"]

    # User content: reference video block + measured stats + platform + description.
    content = captured["messages"][0]["content"]
    file_blocks = [c for c in content if c.get("type") == "file"]
    assert len(file_blocks) == 1
    texts = "\n".join(c["text"] for c in content if c.get("type") == "text")
    assert "<measured_cut_stats>" in texts
    assert "<target_platform>" in texts and "TikTok" in texts
    assert "<style_description>fast angle flips</style_description>" in texts

    # Upload + cleanup, and the guide carries the measured-rhythm line.
    assert uploaded == ["ref.mp4"]
    assert deleted == [["gemini-file://ref.mp4"]]
    assert "Measured rhythm from the reference:" in guide
    assert "Multi-angle flashes vs held shots: cadence most-scenes." in guide


async def test_distill_description_only_omits_platform_stats_and_upload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploaded: list[str] = []
    captured: dict[str, Any] = {}
    _patch_gemini(
        monkeypatch, content=json.dumps(_SAMPLE_OBS), uploaded=uploaded, captured=captured,
    )

    guide = await cut_style.distill_cut_style_prompt(
        None, "calm held shots", target_platform="", project_uid="s1",
    )

    texts = "\n".join(
        c["text"] for c in captured["messages"][0]["content"] if c.get("type") == "text"
    )
    assert "<target_platform>" not in texts  # empty platform → block omitted
    assert "<measured_cut_stats>" not in texts  # no reference → no stats
    assert uploaded == []
    assert "Hook (first 1-3s):" in guide


async def test_distill_deletes_uploaded_files_when_llm_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    ref = tmp_path / "ref.mp4"
    ref.write_bytes(b"fake")
    deleted: list[list[str]] = []
    _patch_gemini(
        monkeypatch, content="", deleted=deleted, stream_error=RuntimeError("boom"),
    )
    monkeypatch.setattr(cut_style, "compute_cut_stats", lambda p: None)

    with pytest.raises(RuntimeError, match="boom"):
        await cut_style.distill_cut_style_prompt(ref, "", project_uid="s1")

    assert deleted == [["gemini-file://ref.mp4"]]  # finally-block cleanup


async def test_distill_requires_reference_or_description(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_gemini(monkeypatch, content=json.dumps(_SAMPLE_OBS))
    with pytest.raises(ValueError):
        await cut_style.distill_cut_style_prompt(None, "   ", project_uid="s1")


# ── apply_cut_style splice (dub_ai) ──────────────────────────────────────────

def test_apply_cut_style_default_splices_default_prose() -> None:
    out = dub_ai.apply_cut_style(dub_ai.DUB_EDIT_SYSTEM_VIDEO)
    assert dub_ai.DEFAULT_CUT_STYLE_PROSE in out
    assert "Aim for multi-angle on ≥60% of lines" in out
    assert "<editing_style>" in out and "</editing_style>" in out
    assert "__CUT_STYLE_BLOCK__" not in out
    assert "SAVED CUT STYLE" not in out


def test_apply_cut_style_custom_wraps_prose_with_precedence() -> None:
    prose = "Cut on every beat; three angles per beat; end on a freeze."
    out = dub_ai.apply_cut_style(dub_ai.DUB_EDIT_SYSTEM_VIDEO, prose)
    assert prose in out
    assert "SAVED CUT STYLE" in out
    # Precedence text: governs pacing instincts, never overrides safety.
    assert "It GOVERNS over" in out
    assert "It NEVER\noverrides <reject_safety>" in out
    # Default prose is fully replaced, not appended.
    assert "Aim for multi-angle" not in out
    assert "__CUT_STYLE_BLOCK__" not in out


def test_apply_cut_style_missing_token_raises() -> None:
    with pytest.raises(ValueError, match="__CUT_STYLE_BLOCK__"):
        dub_ai.apply_cut_style("<role>no token here</role>", "some style")


def test_apply_cut_style_reedit_default_prose() -> None:
    out = dub_ai.apply_cut_style(
        dub_ai.DUB_REEDIT_SYSTEM_VIDEO, default_prose=dub_ai.DEFAULT_REEDIT_CUT_STYLE_PROSE,
    )
    assert dub_ai.DEFAULT_REEDIT_CUT_STYLE_PROSE in out
    assert dub_ai.DEFAULT_CUT_STYLE_PROSE not in out  # re-edit gets its own prose
    assert "__CUT_STYLE_BLOCK__" not in out


# ── style_prompt plumbing through the dub LLM entry points ───────────────────

def _patch_dub_video_call(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any], *, content: str
) -> None:
    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{getattr(path, 'name', path)}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["system"] = system

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
    monkeypatch.setattr(
        "packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model}
    )


async def test_generate_dub_edit_script_video_splices_style_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    _patch_dub_video_call(
        monkeypatch, captured, content='{"mode": "dub_first", "segments": []}'
    )

    await dub_ai.generate_dub_edit_script_video(
        [], brief="", user_script="", target_duration_sec=None, project_uid="p1",
        style_prompt="Hyper-fast angle flips, hold nothing over 1s.",
    )

    sys = captured["system"]
    assert sys == dub_ai.apply_cut_style(
        dub_ai.DUB_EDIT_SYSTEM_VIDEO, "Hyper-fast angle flips, hold nothing over 1s."
    )
    assert "SAVED CUT STYLE" in sys
    assert "Hyper-fast angle flips, hold nothing over 1s." in sys
    assert dub_ai.DEFAULT_CUT_STYLE_PROSE not in sys


async def test_generate_dub_reedit_script_video_uses_reedit_default_prose(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    captured: dict[str, Any] = {}
    _patch_dub_video_call(
        monkeypatch, captured, content='{"mode": "dub_first", "segments": []}'
    )
    preview = tmp_path / "preview.mp4"
    preview.write_bytes(b"fake")

    await dub_ai.generate_dub_reedit_script_video(
        [], (preview, 30.0),
        current_segments=[], selected_line_ids=[], instruction="ตัดให้เร็วขึ้น",
        project_uid="p1",
    )

    assert captured["system"] == dub_ai.apply_cut_style(
        dub_ai.DUB_REEDIT_SYSTEM_VIDEO, "", default_prose=dub_ai.DEFAULT_REEDIT_CUT_STYLE_PROSE
    )
    assert dub_ai.DEFAULT_REEDIT_CUT_STYLE_PROSE in captured["system"]


# ── worker wiring ────────────────────────────────────────────────────────────

def test_distill_style_task_registered() -> None:
    import services.worker.tasks as tasks

    assert hasattr(tasks, "distill_style_local")
    names = {getattr(f, "__name__", "") for f in tasks.WorkerSettings.functions}
    assert "distill_style_local" in names


async def test_distill_style_local_routes_cut_kind_to_cut_distiller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """kind="cut" EffectStyle rows must be distilled by cut_style (with the
    row's target_platform), never by the effects-layer distiller.

    NOTE: services/worker/tasks.py is under active development — if this test
    breaks on unrelated task-plumbing changes, re-check the mocked seams
    (_tenant_session/_update_job/_get_tenant_id_by_slug/_set_video_usage_ctx)
    before touching the routing assertion itself.
    """
    import services.worker.tasks as tasks

    class _FakeStyle:
        kind = "cut"
        description = "fast angle flips"
        target_platform = "tiktok"
        reference_clip_path = None
        system_prompt = None
        status = "pending"
        error_msg = "old"

    class _FakeSession:
        async def get(self, model, uid):
            return _FakeStyle

        async def commit(self) -> None:
            return None

        async def close(self) -> None:
            return None

    async def fake_tenant_session(slug: str) -> _FakeSession:
        return _FakeSession()

    async def fake_update_job(*args: Any, **kwargs: Any) -> None:
        return None

    async def fake_get_tenant_id(slug: str) -> int:
        return 1

    calls: dict[str, Any] = {}

    async def fake_cut_distill(ref, desc, *, target_platform="", project_uid, on_thinking=None):
        calls["cut"] = {"ref": ref, "desc": desc, "platform": target_platform}
        return "CUT GUIDE"

    async def fake_effects_distill(ref, desc, *, project_uid, on_thinking=None):
        calls["effects"] = True
        return "EFFECTS GUIDE"

    monkeypatch.setattr(tasks, "_tenant_session", fake_tenant_session)
    monkeypatch.setattr(tasks, "_update_job", fake_update_job)
    monkeypatch.setattr(tasks, "_get_tenant_id_by_slug", fake_get_tenant_id)
    monkeypatch.setattr(
        tasks, "_set_video_usage_ctx", lambda style, tenant_id, uid, feature="video_cut": None
    )
    # Both distillers are imported inside the task body at call time, so
    # patching the source modules intercepts the routing decision.
    monkeypatch.setattr("packages.video.cut_style.distill_cut_style_prompt", fake_cut_distill)
    monkeypatch.setattr("packages.video.effects_style.distill_style_prompt", fake_effects_distill)

    result = await tasks.distill_style_local(
        {}, job_id="j1", style_uid="s1", tenant_slug="default"
    )

    assert result == {"style_uid": "s1"}
    assert calls["cut"]["desc"] == "fast angle flips"
    assert calls["cut"]["platform"] == "tiktok"
    assert "effects" not in calls  # kind="cut" must NOT hit the effects distiller
    assert _FakeStyle.system_prompt == "CUT GUIDE"
    assert _FakeStyle.status == "ready"
    assert _FakeStyle.error_msg is None
