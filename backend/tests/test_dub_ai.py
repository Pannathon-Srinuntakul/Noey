"""Guard the extracted dub LLM cores against prompt/message-assembly drift.

The golden strings below were captured from services/worker/tasks.py BEFORE the
extraction into packages/video/dub_ai.py — if these tests fail, the refactor
changed model-visible behavior.
"""

from __future__ import annotations

from typing import Any

import pytest

from packages.video import dub_ai


def test_dub_edit_system_golden_anchors() -> None:
    s = dub_ai.DUB_EDIT_SYSTEM
    assert s.startswith("<role>\nYou are a TikTok affiliate video editor. Produce an Edit Script JSON.")
    assert s.endswith("</output_format>")
    # Load-bearing rule fragments (verbatim from the pre-refactor prompt).
    assert 'cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"' in s
    assert "sourceIn must be within ±0.35s of matchedFrameTime" in s
    assert "Hard limit: at most 3 segments per voiceoverLineId" in s
    assert "Total duration is a 45s hard floor (target 50–60s)" in s
    assert 'สั่งได้เลยที่ TikTok Shop' in s


def test_dub_timeline_system_golden_anchors() -> None:
    s = dub_ai.DUB_TIMELINE_SYSTEM
    assert s.startswith("<role>\nYou are a TikTok video editor producing a Timeline JSON for ffmpeg rendering.")
    assert s.endswith("</output_format>")
    assert "Total duration of all cuts MUST NOT exceed voDurationSec" in s
    assert '"label": "opening" for the first cut, "conclusion" for the last cut, "speech" for all others' in s
    assert "Do NOT invent new sourceIn/sourceOut values — copy them from the Edit Script." in s


def test_build_dub_edit_user_text_no_target() -> None:
    text = dub_ai.build_dub_edit_user_text(
        brief="", user_script="", target_duration_sec=None,
        frame_descs="clip0 @ 1.0s", frame_count=1,
    )
    assert text.startswith(
        "<creator_input>\n<brief>(ไม่ระบุ)</brief>\n"
        "<user_script>(ไม่ระบุ — generate จากวิดีโอ)</user_script>\n</creator_input>"
    )
    assert '<frame_timestamps count="1">\nclip0 @ 1.0s\n</frame_timestamps>' in text
    assert "No target set — minimum 45s, target 50–60s" in text
    assert text.endswith("Return ONLY the Edit Script JSON.</instruction>")


def test_build_dub_edit_user_text_with_target_and_inputs() -> None:
    text = dub_ai.build_dub_edit_user_text(
        brief="ขายเสื้อ", user_script="สคริปต์ผู้ใช้", target_duration_sec=30,
        frame_descs="d", frame_count=2,
    )
    assert "<brief>ขายเสื้อ</brief>" in text
    assert "<user_script>สคริปต์ผู้ใช้</user_script>" in text
    assert "Target video length: ~30 seconds." in text
    assert "so all cuts total ~30s — add more lines if needed." in text


def test_build_dub_timeline_prompt_golden() -> None:
    prompt = dub_ai.build_dub_timeline_prompt({"segments": []}, 42.257)
    assert prompt == (
        "<voiceover>\n<voDurationSec>42.26</voDurationSec>\n</voiceover>\n\n"
        '<edit_script>\n{"segments": []}\n</edit_script>\n\n'
        "<instruction>Map each segment to a timeline cut. "
        "Total cut duration MUST NOT exceed 42.26 seconds.</instruction>"
    )


def test_dub_edit_reminder_golden() -> None:
    assert dub_ai.DUB_EDIT_REMINDER == "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"


@pytest.mark.asyncio
async def test_generate_dub_edit_script_message_assembly(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """The Vision call receives: [user text, vision content..., reminder] + system prompt."""
    frame_file = tmp_path / "f0.jpg"
    frame_file.write_bytes(b"\xff\xd8\xff\xe0fakejpeg")
    frames = [{
        "clip_id": "clip0", "time": 1.5, "frame_path": str(frame_file),
        "scene_idx": 0, "scene_start": 1.0, "scene_end": 3.0,
    }]

    captured: dict[str, Any] = {}

    async def fake_upload(all_frames: list[dict]) -> tuple[list[dict], dict, list[str]]:
        return [{"type": "file", "file_id": "file_x"}], {"upload_ms": 1}, ["file_x"]

    deleted: list[list[str]] = []

    async def fake_delete(ids: list[str]) -> None:
        deleted.append(ids)

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured["messages"] = messages
        captured["system"] = system

        class _Msg:
            content = '{"mode": "dub_first", "segments": [{"order": 1, "sourceClip": "clip0", "sourceIn": 1.5, "sourceOut": 3.0}]}'

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()

    monkeypatch.setattr("packages.video.scene.build_vision_content_uploaded", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_message_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr("packages.llm.config.vision_call_kwargs", lambda: {"model": "test/model"})

    result = await dub_ai.generate_dub_edit_script(
        frames, brief="b", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )

    content = captured["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert content[0]["text"].startswith("<creator_input>")
    assert content[1] == {"type": "file", "file_id": "file_x"}
    assert content[-1]["text"] == dub_ai.DUB_EDIT_REMINDER
    assert captured["system"] == dub_ai.DUB_EDIT_SYSTEM
    assert deleted == [["file_x"]]  # files cleaned up even on success
    assert result["segments"][0]["sourceClip"] == "clip0"


@pytest.mark.asyncio
async def test_plan_dub_timeline_cuts_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM cuts run through localize + short-cut filtering against clip boundaries."""

    async def fake_complete(prompt: str, *, system: str) -> str:
        assert system == dub_ai.DUB_TIMELINE_SYSTEM
        return (
            '{"timeline": ['
            '{"type": "cut", "source": "clip0", "in": 1.0, "out": 4.0, "label": "opening"},'
            '{"type": "cut", "source": "clip0", "in": 5.0, "out": 5.1, "label": "speech"},'
            '{"type": "cut", "source": "clip1", "in": 2.0, "out": 6.0, "label": "conclusion"}'
            "]}"
        )

    monkeypatch.setattr("packages.llm.gateway.complete", fake_complete)

    cuts = await dub_ai.plan_dub_timeline_cuts(
        {"segments": []}, vo_duration=8.0, clip_durations=[10.0, 10.0]
    )
    # 0.1s cut dropped by MIN_RENDER_CUT_SEC filter; two survive.
    assert len(cuts) == 2
    assert all(c["out"] - c["in"] >= 0.5 for c in cuts)


@pytest.mark.asyncio
async def test_plan_dub_timeline_cuts_empty_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_complete(prompt: str, *, system: str) -> str:
        return '{"timeline": []}'

    monkeypatch.setattr("packages.llm.gateway.complete", fake_complete)
    with pytest.raises(ValueError, match="empty timeline"):
        await dub_ai.plan_dub_timeline_cuts({"segments": []}, 10.0, [10.0])
