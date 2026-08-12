"""Tests for the effects placement AI call — motion only (zoomPunches,
transitions, sceneDrifts) plus the optional style-reference wiring."""

from __future__ import annotations

from typing import Any

import pytest

from packages.video import effects_ai


def _patch_common(monkeypatch: pytest.MonkeyPatch, *, content: str, uploaded: list[str] | None = None) -> None:
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
    monkeypatch.setattr("packages.video.ffmpeg_bin.media_duration", lambda path: 20.0)


def _empty_placement(**overrides: Any) -> str:
    import json

    base = {"zoomPunches": [], "transitions": [], "sceneDrifts": []}
    base.update(overrides)
    return json.dumps(base, ensure_ascii=False)


def test_zoom_ramp_sec_clamps_per_style() -> None:
    # push: model-controlled but clamped to a real eased range, never more
    # than half the hold.
    assert effects_ai._zoom_ramp_sec("push", 3.0, 1.5) == pytest.approx(1.5)
    assert effects_ai._zoom_ramp_sec("push", 6.0, 10.0) == pytest.approx(2.5)  # capped at 2.5
    assert effects_ai._zoom_ramp_sec("push", 3.0, 0.05) == pytest.approx(0.3)  # floor at 0.3
    # 0.3 floor wins over the half-hold cap (0.2) on a very short hold.
    assert effects_ai._zoom_ramp_sec("push", 0.4, 2.0) == pytest.approx(0.3)
    # cut: always near-instant regardless of what the model asked for.
    assert effects_ai._zoom_ramp_sec("cut", 3.0, 2.0) == pytest.approx(0.15)
    assert effects_ai._zoom_ramp_sec("cut", 3.0, 0.0) == pytest.approx(0.05)
    # missing/garbage style treated as cut; missing rampSec on a non-push
    # style falls back to the near-instant 0.05 default.
    assert effects_ai._zoom_ramp_sec(None, 3.0, None) == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_zoom_punch_trimmed_to_next_cut(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Live report 2026-07-18: AI often holds a punch-zoom across a scene cut,
    # so the next shot opens still zoomed. When <cuts> are known, clamp the
    # window to end at the next cut.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 6.0, "durationSec": 5.0, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "cut", "rampSec": 0.05,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    assert inst["startSec"] == pytest.approx(6.0)
    # Would have run 6→11; trimmed to the cut at 9.
    assert inst["durationSec"] == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_zoom_punch_trim_to_cut_enforces_min_hold(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Live report 2026-07-19: a model-picked startSec very close to the real
    # cut left almost no room after hard-trimming to that cut — the observed
    # result was a 0.1s zoom (a single-frame flash, looked like the clip
    # glitching). When trimming to the next cut leaves too little room, pull
    # startSec earlier instead of shipping a sub-perceptible hold.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 8.9, "durationSec": 5.0, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "cut", "rampSec": 0.05,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    # Naive trim would give startSec=8.9, durationSec=0.1 — too short.
    # startSec pulled back so the hold still ends exactly on the cut at 9.0
    # but lasts the enforced minimum instead.
    assert inst["durationSec"] == pytest.approx(0.7)
    assert inst["startSec"] == pytest.approx(8.3)


@pytest.mark.asyncio
async def test_zoom_punch_cut_style_start_snaps_to_nearby_cut(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Live report 2026-07-19: "cut" style is supposed to read as a real edit
    # cut into a close-up, but nothing actually anchored startSec to a real
    # cut boundary — a mid-scene start still hard-snapped to zoom_to
    # instantly (correct per the filter) but had no real cut underneath,
    # reading as an unmotivated pop instead of a deliberate cut. When the
    # model's startSec is already close to a real cut, snap it exactly on.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 5.2, "durationSec": 2.0, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "cut", "rampSec": 0.05,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    # startSec (0.2s from the cut at 5.0) snapped exactly onto it; end (7.2)
    # is untouched since it's nowhere near a cut. Duration grows to match.
    assert inst["startSec"] == pytest.approx(5.0)
    assert inst["durationSec"] == pytest.approx(2.2)


@pytest.mark.asyncio
async def test_zoom_punch_push_style_start_not_snapped(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # The start-snap is "cut"-style only — "push" is a deliberate mid-scene
    # ease-in and must NOT get yanked onto a cut boundary.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 5.2, "durationSec": 2.0, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "push", "rampSec": 1.0,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    assert inst["startSec"] == pytest.approx(5.2)
    assert inst["durationSec"] == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_zoom_punch_soft_snaps_to_nearby_cut(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Live report 2026-07-19: the model's own duration estimate frequently
    # lands the hold's release a few frames short of the true cut (not past
    # it — that's the hard-trim case above) — visible as the shot briefly
    # un-zooming before the real scene change. When the naive end is already
    # close to a real cut, pull it exactly onto that cut.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 6.0, "durationSec": 2.85, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "cut", "rampSec": 0.05,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    assert inst["startSec"] == pytest.approx(6.0)
    # Naive end was 6.0+2.85=8.85 (0.15s short of the real cut at 9.0) — snapped.
    assert inst["durationSec"] == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_zoom_punch_no_snap_when_cut_far_away(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 6.0, "durationSec": 1.5, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.4, "style": "cut", "rampSec": 0.05,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert len(doc["instances"]) == 1
    # End (7.5) is >0.4s from the nearest cut (9.0) — left untouched.
    assert doc["instances"][0]["durationSec"] == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_zoom_punch_hold_true_when_ending_on_real_cut(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {"startSec": 5.0, "durationSec": 4.0, "style": "cut"},  # ends exactly at the real cut (9.0)
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert doc["instances"][0]["props"]["hold"] == "true"


@pytest.mark.asyncio
async def test_zoom_punch_hold_false_when_release_is_mid_scene(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Live report 2026-07-19: the model was previously forced to always hold
    # to the scene's own cut — now that a genuine mid-scene release is
    # allowed, it must ease out (hold=false) rather than snap, since there's
    # no real cut at that point to justify an instant change.
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {"startSec": 5.0, "durationSec": 1.5, "style": "cut"},  # ends at 6.5 — far from any real cut
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[5.0, 9.0, 13.0]
    )

    assert doc["instances"][0]["props"]["hold"] == "false"


@pytest.mark.asyncio
async def test_zoom_punch_hold_true_when_no_cut_points_given(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {"startSec": 5.0, "durationSec": 1.5, "style": "cut"},
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert doc["instances"][0]["props"]["hold"] == "true"


@pytest.mark.asyncio
async def test_zoom_punch_style_sets_cut_flag(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {"startSec": 1.0, "durationSec": 2.0, "style": "cut"},
        {"startSec": 5.0, "durationSec": 2.0, "style": "push"},
        {"startSec": 9.0, "durationSec": 2.0},  # no style → defaults to cut
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert [inst["props"]["cut"] for inst in doc["instances"]] == ["true", "false", "true"]


@pytest.mark.asyncio
async def test_zoom_punch_uses_model_ramp_sec(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(zoomPunches=[
        {
            "startSec": 5.0, "durationSec": 4.0, "focusX": 0.5, "focusY": 0.5,
            "zoomTo": 1.5, "style": "push", "rampSec": 1.8,
        },
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert len(doc["instances"]) == 1
    assert doc["instances"][0]["props"]["rampSec"] == pytest.approx(1.8)


@pytest.mark.asyncio
async def test_transition_snaps_to_nearest_real_cut(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(transitions=[
        {"cutSec": 9.9, "durationSec": 0.3, "direction": "horizontal", "intensity": 0.7},
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[3.0, 10.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    assert inst["kind"] == "transform"
    assert inst["componentId"] == "whip-pan"
    # Snapped to the real cut at 10.0, not the model's slightly-off 9.9.
    assert inst["startSec"] == pytest.approx(9.85, abs=0.01)
    assert inst["durationSec"] == pytest.approx(0.3, abs=0.01)
    assert inst["props"]["direction"] == "horizontal"
    assert inst["props"]["intensity"] == pytest.approx(0.7)


@pytest.mark.asyncio
async def test_transitions_ignored_without_cut_points(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(transitions=[
        {"cutSec": 5.0, "durationSec": 0.3, "direction": "horizontal", "intensity": 0.5},
    ])
    _patch_common(monkeypatch, content=content)

    # No cut_points_sec passed — the model has nothing real to anchor to, so
    # any transitions it returns anyway (schema doesn't forbid it) are ignored.
    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert doc["instances"] == []


@pytest.mark.asyncio
async def test_dropped_transitions_and_drifts_are_logged(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Regression for a real observed run (2026-07-18): the model correctly
    planned transitions/sceneDrifts but the caller gave no <cuts>, so they were
    discarded with zero trace. Must be visible in logs, not silent."""
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(
        transitions=[{"cutSec": 5.0, "durationSec": 0.3, "direction": "horizontal", "intensity": 0.5}],
        sceneDrifts=[{"startSec": 0.0, "durationSec": 5.0, "zoomTo": 1.1, "direction": "in"}],
    )
    _patch_common(monkeypatch, content=content)

    logged: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        effects_ai.log, "warning",
        lambda event, **kw: logged.append((event, kw)),
    )

    await effects_ai.generate_effects_placement(video, project_uid="p1")

    events = {e for e, _ in logged}
    assert "effects_ai_transitions_dropped_no_cuts" in events
    assert "effects_ai_scene_drifts_dropped_no_cuts" in events


@pytest.mark.asyncio
async def test_cuts_section_present_only_when_cut_points_given(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["system"] = system
        captured["user_text"] = messages[0]["content"][-1]["text"]

        class _Msg:
            content = _empty_placement()

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

    await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[2.5, 8.0]
    )

    assert "<transition>" in captured["system"]
    assert "<cuts>2.50, 8.00</cuts>" in captured["user_text"]


@pytest.mark.asyncio
async def test_regenerate_with_style_does_not_license_dropping_technique(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Regression for a real observed run (2026-07-18): a regenerate whose
    <previous_attempt> happened to use sceneDrifts caused the model to drop
    sceneDrifts entirely on the retake, reasoning "the previous attempt
    leaned heavily on scene-drift" — even though the active <style> called
    for exactly that. The regenerate instruction must not read as license to
    change TECHNIQUE choices that a style already settled, only content."""
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["user_text"] = messages[0]["content"][-1]["text"]

        class _Msg:
            content = _empty_placement()

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

    previous_doc = {"instances": [{"id": "drift_ai_0", "kind": "transform", "componentId": "scene-drift"}]}

    await effects_ai.generate_effects_placement(
        video, project_uid="p1", previous_doc=previous_doc,
        style_prompt="Use frequent slow handheld drift across the whole clip.",
    )

    assert "still applies" in captured["user_text"]
    assert "TECHNIQUE" in captured["user_text"]


@pytest.mark.asyncio
async def test_regenerate_without_style_omits_technique_note(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["user_text"] = messages[0]["content"][-1]["text"]

        class _Msg:
            content = _empty_placement()

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

    previous_doc = {"instances": [{"id": "zoom_ai_0", "kind": "transform", "componentId": "punch-zoom"}]}

    await effects_ai.generate_effects_placement(
        video, project_uid="p1", previous_doc=previous_doc,
    )

    assert "still applies" not in captured["user_text"]
    assert "CLEARLY DIFFERENT" in captured["user_text"]


@pytest.mark.asyncio
async def test_scene_drift_snaps_to_real_scene_boundaries(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(sceneDrifts=[
        # Model's raw values are slightly off the real cuts (3.0, 9.0) and
        # the clip end (20.0, per fake duration below) — must snap to those.
        {"startSec": 3.2, "durationSec": 5.5, "zoomTo": 1.2, "direction": "left"},
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[3.0, 9.0]
    )

    assert len(doc["instances"]) == 1
    inst = doc["instances"][0]
    assert inst["kind"] == "transform"
    assert inst["componentId"] == "scene-drift"
    assert inst["startSec"] == pytest.approx(3.0)
    assert inst["durationSec"] == pytest.approx(6.0)  # snapped to span 3.0 -> 9.0
    assert inst["props"]["focusToX"] < inst["props"]["focusFromX"]  # "left" bias


@pytest.mark.asyncio
async def test_scene_drift_ignored_without_cut_points(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    content = _empty_placement(sceneDrifts=[
        {"startSec": 0, "durationSec": 5.0, "zoomTo": 1.2, "direction": "in"},
    ])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert doc["instances"] == []


@pytest.mark.asyncio
async def test_reference_block_included_in_message(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    reference = tmp_path / "ref.mp4"
    reference.write_bytes(b"fake-ref")

    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["messages"] = messages
        captured["system"] = system

        class _Msg:
            content = _empty_placement()

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

    await effects_ai.generate_effects_placement(
        video, project_uid="p1", reference_path=reference
    )

    content = captured["messages"][0]["content"]
    labels = [c["text"] for c in content if c.get("type") == "text"]
    assert "=== style reference (NOT the actual clip) ===" in labels
    assert "=== cut video ===" in labels
    assert "<reference>" in captured["system"]
    # No placeholder token survives into the real prompt.
    assert "__" not in captured["system"].replace("__STYLE_PROSE__", "")


@pytest.mark.asyncio
async def test_no_reference_omits_the_optional_section(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")

    captured: dict[str, Any] = {}

    async def fake_upload(path, *, mime_type="video/mp4"):
        return f"gemini-file://{path.name}"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["system"] = system

        class _Msg:
            content = _empty_placement()

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

    await effects_ai.generate_effects_placement(video, project_uid="p1")

    assert "<reference>" not in captured["system"]
    assert "=== style reference" not in captured["system"]


@pytest.mark.asyncio
async def test_open_out_zoom_is_forced_eased_and_held(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """zoomFrom > zoomTo is the reveal move (R8 "ซูมออกช้า"). A "cut" entry or a
    ramp-back release would both erase it, so the parser overrides the model."""
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    content = _empty_placement(zoomPunches=[{
        "startSec": 0.0, "durationSec": 2.6, "focusOn": "logo",
        "focusX": 0.52, "focusY": 0.34,
        "zoomFrom": 1.9, "zoomTo": 1.0,
        # The model asked for a hard cut; an open-out cannot be one.
        "style": "cut", "rampSec": 1.6, "driftX": 0.52, "driftY": 0.34,
    }])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")
    props = doc["instances"][0]["props"]
    assert props["zoomFrom"] == 1.9
    assert props["zoomTo"] == 1.0
    assert props["cut"] == "false"      # forced eased
    assert props["hold"] == "true"      # no ramp-back re-tightening the frame
    # Push clamp, not the 0.05-0.15 cut clamp: 1.6 requested, capped at half
    # the 2.6s window so the ramp cannot eat the whole move.
    assert props["rampSec"] == 1.3


@pytest.mark.asyncio
async def test_push_in_still_defaults_to_zoom_from_one(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    content = _empty_placement(zoomPunches=[{
        "startSec": 1.0, "durationSec": 2.0, "focusOn": "hem",
        "focusX": 0.5, "focusY": 0.8, "zoomTo": 1.4,
        "style": "push", "rampSec": 1.0, "driftX": 0.5, "driftY": 0.8,
    }])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(video, project_uid="p1")
    props = doc["instances"][0]["props"]
    assert props["zoomFrom"] == 1.0
    assert props["zoomTo"] == 1.4
    assert props["cut"] == "false"


@pytest.mark.asyncio
async def test_scene_drift_can_open_out(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    video = tmp_path / "cut.mp4"
    video.write_bytes(b"fake")
    content = _empty_placement(sceneDrifts=[{
        "startSec": 0.0, "durationSec": 6.0,
        "zoomFrom": 1.4, "zoomTo": 1.0, "direction": "in",
    }])
    _patch_common(monkeypatch, content=content)

    doc = await effects_ai.generate_effects_placement(
        video, project_uid="p1", cut_points_sec=[6.0],
    )
    props = doc["instances"][0]["props"]
    assert props["zoomFrom"] == 1.4
    assert props["zoomTo"] == 1.0
