"""Gemini native-video dub_first path (desktop only) — guards prompt drift and
message assembly against the Claude+frames path in test_dub_ai.py.
"""

from __future__ import annotations

from typing import Any

import pytest

from packages.video import dub_ai


def test_dub_edit_system_video_matches_claude_rules() -> None:
    """Invariant rules that live in the RAW const (never in the swappable
    <editing_style> block) — safety, anchoring, span selection, coverage."""
    s = dub_ai.DUB_EDIT_SYSTEM_VIDEO
    assert s.startswith("<role>\nYou are a TikTok affiliate video editor. Produce an Edit Script JSON.")
    assert s.endswith("</output_format>")
    # Editorial rules must be byte-identical to the Claude+frames prompt.
    assert 'cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"' in s
    assert "No fixed segment cap per voiceoverLineId" in s
    # v2: the 45s figure survives as CALIBRATION only — the quota language
    # (hard floor / line counts) is exactly what the rewrite removed.
    assert "about 45 seconds" in s
    assert "hard floor" not in s
    assert "12–18 lines" not in s
    assert 'สั่งได้เลยที่ TikTok Shop' in s
    assert "zero reject_safety violations remain" in s
    # Safety + anchoring invariants stay in the raw const — a saved cut style
    # must never be able to displace them.
    assert "HARD REJECT" in s
    assert "ANY visible underwear" in s
    # v2 anchor: the trim may slide FORWARD to where the action lands, only
    # backward drift (into prep) stays forbidden.
    assert "sourceIn must be ≥ matchedFrameTime − 0.35s" in s
    assert "Starting LATER than the anchor is allowed" in s
    # The editing style itself is spliced at call time via this token. The raw
    # const may still MENTION "<editing_style>" by name (verify/authenticity
    # rules point at the section), but the section body must not be baked in.
    assert "__CUT_STYLE_BLOCK__" in s
    assert "</editing_style>" not in s  # only the spliced version has the section
    # Verify re-checks each line against the spliced <editing_style> section
    # (replaces the old hardcoded "multi-angle on ≥60%" verify clause).
    assert (
        "every line's cut pattern follows the <editing_style> section above "
        "(re-check each line against it before finalizing)" in s
    )
    # Frame-list mechanics changed — no frame-sample wording, no frame classification wording.
    assert "sample frame you chose" not in s
    assert "Classify every frame before using it" not in s
    assert "Classify each shot as you watch:" in s
    # New multi-clip labeling line.
    assert '=== clip0 ===' in s
    assert "the exact timestamp (seconds) in the video you chose for this cut" in s
    # Coverage rule — watch every clip in full before selecting, regardless of target duration.
    assert "Watch EVERY clip in FULL, start to finish, before selecting anything" in s
    # v2 coverage: reviewing everything is mandatory, USING everything is not.
    assert "Reviewing all of it is mandatory. USING all of it is not." in s
    assert "you watched every clip to its FULL given duration" in s
    # v2 selection model: spans bounded by action arcs, ranked; prep is the
    # leading edge of its span, never a span of its own.
    assert "<scene_spans>" in s
    assert "Preparation is NEVER a span of its own" in s
    assert "the action has ARRIVED, not begun" in s
    # Order is the only continuity rule left (2026-08-18). A wardrobe/location
    # change BETWEEN clips is the user's choice, not an error to edit around —
    # the previous "state must not go backwards" wording made the model stay
    # inside one clip and ignore the other four the user had sent.
    assert "Never cut backwards" in s
    assert "is not a continuity error and is never a reason to avoid a clip" in s
    assert "State must not go backwards" not in s
    # Hard numeric bound — sourceOut must never exceed a clip's real duration.
    assert "sourceOut can never exceed the clip's duration" in s
    # Quality over duration — never fabricate timestamps to run longer.
    assert "Never invent a timestamp beyond a clip's real duration" in s
    # 1fps precision rule — brief/transitional poses (e.g. a quick back-view
    # turn) are unreliable to timestamp exactly; prefer held moments.
    assert "you sample the video at 1 frame/second" in s
    assert "Prefer moments that are HELD for at least ~1 second" in s


def test_dub_edit_system_video_default_splice_keeps_editing_style_rules() -> None:
    """The editing-style sentences that used to be baked into the raw const now
    arrive via apply_cut_style — with no saved style the model-visible prompt
    must still contain every one of them (behavior-preserving default)."""
    spliced = dub_ai.apply_cut_style(dub_ai.DUB_EDIT_SYSTEM_VIDEO)
    assert "__CUT_STYLE_BLOCK__" not in spliced
    assert "<editing_style>" in spliced and "</editing_style>" in spliced
    # The extracted default prose is spliced verbatim.
    assert dub_ai.DEFAULT_CUT_STYLE_PROSE in spliced
    # Load-bearing style sentences (previously asserted on the raw const).
    assert "Aim for multi-angle on ≥60% of lines" in spliced
    assert "each line must look VISUALLY DIFFERENT from the one before" in spliced
    # v2 prose: variety is visual, not temporal — same-span pulls preferred.
    assert "prefer pulling them from the same span or adjacent ones" in spliced
    assert "continuity outranks variety" in spliced
    assert "each cut 0.5–1.5s" in spliced
    # Multi-angle reinforcement (video-specific, addresses observed under-use).
    assert "you MUST split it into multi-angle cuts" in spliced
    # NO_VO variant paces per <editing_style> instead of per dialogue line.
    no_vo = dub_ai.apply_cut_style(dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO)
    assert "Pace cuts per the <editing_style> section" in no_vo
    assert dub_ai.DEFAULT_CUT_STYLE_PROSE in no_vo


def test_build_dub_edit_context_text_video() -> None:
    """Data-only block sent BEFORE the video — no directives (Gemini long-video guidance)."""
    text = dub_ai.build_dub_edit_context_text_video(
        brief="ขายเสื้อ", user_script="สคริปต์ผู้ใช้",
        clip_durations=[("clip0", 47.3)],
    )
    assert text.startswith(
        "<creator_input>\n<brief>ขายเสื้อ</brief>\n"
        "<user_script>สคริปต์ผู้ใช้</user_script>\n</creator_input>"
    )
    assert "<frame_timestamps" not in text
    # <clips> states a valid RANGE per clip — the bound is what the model kept
    # violating, so it reads as a constraint on the answer rather than a fact
    # about the file. Interpolated from the probe; never a literal.
    assert "<clips>\nclip0: 47.3s — valid timestamps 0.0 to 47.3, nothing beyond 47.3 exists\n</clips>" in text
    assert "<instruction>" not in text  # directives live in the post-video block


def test_build_dub_edit_context_text_video_no_input() -> None:
    text = dub_ai.build_dub_edit_context_text_video(
        brief="", user_script="",
        clip_durations=[("clip0", 12.0), ("clip1", 8.5)],
    )
    assert "<brief>(ไม่ระบุ)</brief>" in text
    assert "clip0: 12.0s — valid timestamps 0.0 to 12.0" in text
    assert "clip1: 8.5s — valid timestamps 0.0 to 8.5" in text


def test_build_dub_edit_instruction_text_video_with_target() -> None:
    """Directive block sent AFTER the video — target duration set."""
    text = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=30, clip_durations=[("clip0", 47.3)],
    )
    assert text.startswith("<instruction>")
    assert "Requested video length: ~30 seconds" in text
    # v2: an explicit target is an aim and a CEILING, never a quota.
    assert "CEILING" in text
    assert "deliver the shorter honest cut" in text
    assert "Based on the video(s) above: watch each clip in full for its ENTIRE given duration" in text
    assert text.endswith("Return ONLY the Edit Script JSON.</instruction>")


def test_build_dub_edit_instruction_text_video_no_target() -> None:
    text = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=[("clip0", 12.0), ("clip1", 8.5)],
    )
    assert "No target set. Calibration:" in text
    assert "minimum 45s" not in text
    assert "available footage across all clips is 20.5s" in text


@pytest.mark.asyncio
async def test_generate_dub_edit_script_video_message_assembly(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Each clip is uploaded via Files API and referenced by file_id; timestamps
    pass through untouched (sample_frames=None skips frame-anchoring)."""
    clip0 = tmp_path / "clip0.mp4"
    clip0.write_bytes(b"fake-mp4-0")
    clip1 = tmp_path / "clip1.mp4"
    clip1.write_bytes(b"fake-mp4-1")

    uploaded: list[str] = []

    async def fake_upload(path, *, mime_type="video/mp4"):
        uploaded.append(path.name)
        return f"gemini-file://{path.name}"

    deleted: list[list[str]] = []

    async def fake_delete(file_ids: list[str]) -> None:
        deleted.append(file_ids)

    captured: dict[str, Any] = {}

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["messages"] = messages
        captured["system"] = system
        captured["kwargs"] = kwargs

        class _Msg:
            content = (
                '{"mode": "dub_first", "segments": ['
                '{"order": 1, "voiceoverLineId": 1, "sourceClip": "clip0", '
                '"sourceIn": 5.2, "sourceOut": 8.0, "matchedFrameTime": 5.2, '
                '"voiceoverScript": "hi"}'
                ']}'
            )

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})

    result = await dub_ai.generate_dub_edit_script_video(
        [("clip0", clip0, 12.0), ("clip1", clip1, 8.0)],
        brief="b", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )

    assert uploaded == ["clip0.mp4", "clip1.mp4"]
    # System prompt = the raw const with the default editing style spliced in.
    assert captured["system"] == dub_ai.apply_cut_style(dub_ai.DUB_EDIT_SYSTEM_VIDEO)

    content = captured["messages"][0]["content"]
    # Order matters here: Gemini's long-video guidance is data first, directives
    # last — context text, then both video blocks, then instruction, then reminder.
    assert content[0]["type"] == "text"
    assert content[0]["text"].startswith("<creator_input>")
    assert "clip0: 12.0s — valid timestamps 0.0 to 12.0" in content[0]["text"]
    assert "clip1: 8.0s — valid timestamps 0.0 to 8.0" in content[0]["text"]
    assert "<instruction>" not in content[0]["text"]

    video_blocks = [c for c in content if c.get("type") == "file"]
    assert len(video_blocks) == 2
    assert video_blocks[0]["file"]["file_id"] == "gemini-file://clip0.mp4"
    assert "detail" not in video_blocks[0]["file"]  # default media_resolution, not "low"
    assert video_blocks[1]["file"]["file_id"] == "gemini-file://clip1.mp4"
    first_video_idx = next(i for i, c in enumerate(content) if c.get("type") == "file")
    assert first_video_idx > 0  # video comes after the context block, not before

    label_texts = [c["text"] for c in content if c.get("type") == "text"]
    assert "=== clip0 ===" in label_texts
    assert "=== clip1 ===" in label_texts
    instruction_text = content[-2]["text"]
    assert instruction_text.startswith("<instruction>")
    assert "No target set. Calibration:" in instruction_text
    last_video_idx = max(i for i, c in enumerate(content) if c.get("type") == "file")
    instruction_idx = next(i for i, c in enumerate(content) if c["type"] == "text" and c["text"].startswith("<instruction>"))
    assert instruction_idx > last_video_idx  # directives sent after all video blocks
    assert content[-1]["text"] == dub_ai.DUB_EDIT_REMINDER

    # Timestamps pass through untouched — no frame-anchoring (sample_frames=None).
    seg = result["segments"][0]
    assert seg["sourceClip"] == "clip0"
    assert seg["sourceIn"] == 5.2
    assert seg["sourceOut"] == 8.0

    # Cleanup runs once with both uploaded file_ids, even on success.
    assert deleted == [["gemini-file://clip0.mp4", "gemini-file://clip1.mp4"]]

    # Structured output enforced — Gemini has been observed inventing its own
    # top-level keys ("narrative_progression") instead of "segments" without this.
    rf = captured["kwargs"]["response_format"]
    assert rf["type"] == "json_object"
    assert rf["enforce_validation"] is True
    # Fresh-edit calls send the bounded variant: the model echoes each clip's
    # end time as clipBounds before it may emit any segment.
    assert rf["response_schema"] == dub_ai.DUB_EDIT_SCHEMA_VIDEO_BOUNDED
    assert "segments" in rf["response_schema"]["required"]


@pytest.mark.asyncio
async def test_generate_dub_edit_script_video_drops_out_of_range_segments(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Regression test: Gemini hallucinated a segment past the real 40s clip length
    in production (54s script from a 40s clip) — the clamp safety net must catch it."""
    clip0 = tmp_path / "clip0.mp4"
    clip0.write_bytes(b"fake-mp4-0")

    async def fake_upload(path, *, mime_type="video/mp4"):
        return "gemini-file://clip0.mp4"

    async def fake_delete(file_ids: list[str]) -> None:
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        class _Msg:
            content = (
                '{"mode": "dub_first", "segments": ['
                '{"order": 1, "voiceoverLineId": 1, "sourceClip": "clip0", '
                '"sourceIn": 5.0, "sourceOut": 8.0, "matchedFrameTime": 5.0, "voiceoverScript": "hi"},'
                '{"order": 2, "voiceoverLineId": 2, "sourceClip": "clip0", '
                '"sourceIn": 49.0, "sourceOut": 54.0, "matchedFrameTime": 49.0}'
                ']}'
            )

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})

    result = await dub_ai.generate_dub_edit_script_video(
        [("clip0", clip0, 40.0)],  # real clip is only 40s
        brief="", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )

    assert len(result["segments"]) == 1
    assert result["segments"][0]["sourceOut"] == 8.0


@pytest.mark.asyncio
async def test_generate_dub_edit_script_video_deletes_files_on_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Uploaded files are cleaned up even when the LLM call raises."""
    clip0 = tmp_path / "clip0.mp4"
    clip0.write_bytes(b"fake-mp4-0")

    async def fake_upload(path, *, mime_type="video/mp4"):
        return "gemini-file://clip0.mp4"

    deleted: list[list[str]] = []

    async def fake_delete(file_ids: list[str]) -> None:
        deleted.append(file_ids)

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model})

    with pytest.raises(RuntimeError, match="boom"):
        await dub_ai.generate_dub_edit_script_video(
            [("clip0", clip0, 12.0)],
            brief="", user_script="", target_duration_sec=None,
            project_uid="p1", on_thinking=None,
        )

    assert deleted == [["gemini-file://clip0.mp4"]]
