"""Gemini native-video dub_first path (desktop only) — guards prompt drift and
message assembly against the Claude+frames path in test_dub_ai.py.
"""

from __future__ import annotations

from typing import Any

import pytest

from packages.video import dub_ai


def test_dub_edit_system_video_matches_claude_rules() -> None:
    s = dub_ai.DUB_EDIT_SYSTEM_VIDEO
    assert s.startswith("<role>\nYou are a TikTok affiliate video editor. Produce an Edit Script JSON.")
    assert s.endswith("</output_format>")
    # Editorial rules must be byte-identical to the Claude+frames prompt.
    assert 'cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"' in s
    assert "Hard limit: at most 3 segments per voiceoverLineId" in s
    assert "Total duration is a 45s hard floor (target 50–60s)" in s
    assert 'สั่งได้เลยที่ TikTok Shop' in s
    assert "zero reject_safety violations remain" in s
    # Frame-list mechanics changed — no frame-sample wording, no frame classification wording.
    assert "sample frame you chose" not in s
    assert "Classify every frame before using it" not in s
    assert "Classify each shot as you watch the video" in s
    # New multi-clip labeling line.
    assert '=== clip0 ===' in s
    assert "the exact timestamp (seconds) in the video you chose for this cut" in s


def test_build_dub_edit_user_text_video_no_frame_timestamps() -> None:
    text = dub_ai.build_dub_edit_user_text_video(
        brief="ขายเสื้อ", user_script="สคริปต์ผู้ใช้", target_duration_sec=30,
    )
    assert text.startswith(
        "<creator_input>\n<brief>ขายเสื้อ</brief>\n"
        "<user_script>สคริปต์ผู้ใช้</user_script>\n</creator_input>"
    )
    assert "<frame_timestamps" not in text
    assert "Target video length: ~30 seconds." in text
    assert text.endswith("Return ONLY the Edit Script JSON.</instruction>")


def test_build_dub_edit_user_text_video_no_target() -> None:
    text = dub_ai.build_dub_edit_user_text_video(
        brief="", user_script="", target_duration_sec=None,
    )
    assert "<brief>(ไม่ระบุ)</brief>" in text
    assert "No target set — minimum 45s, target 50–60s" in text
    assert "<frame_timestamps" not in text


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
    assert captured["system"] == dub_ai.DUB_EDIT_SYSTEM_VIDEO

    content = captured["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert content[0]["text"].startswith("<creator_input>")

    video_blocks = [c for c in content if c.get("type") == "file"]
    assert len(video_blocks) == 2
    assert video_blocks[0]["file"]["file_id"] == "gemini-file://clip0.mp4"
    assert video_blocks[0]["file"]["detail"] == "low"
    assert video_blocks[1]["file"]["file_id"] == "gemini-file://clip1.mp4"

    label_texts = [c["text"] for c in content if c.get("type") == "text"]
    assert "=== clip0 ===" in label_texts
    assert "=== clip1 ===" in label_texts
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
    assert rf["response_schema"] == dub_ai.DUB_EDIT_SCHEMA_VIDEO
    assert "segments" in rf["response_schema"]["required"]


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
