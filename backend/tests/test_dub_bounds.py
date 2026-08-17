"""The bounds guard on the native-video edit call.

Same clip (291.7s), same prompt, same uploaded bytes, four runs: two came back
with every timestamp inside the footage and rendered well; two invented
timestamps up to 442s, lost 43-45% of their segments to the clamp, and rendered
as 17-second fragments. The duration was already stated four times in the
request, so the guard is in code as well as prose: the model echoes each clip's
end time before it may emit segments, and the call is retried once when the
clamp would discard too much.

The shot-selection half of the prompt is deliberately untouched by all of this
— <scene_spans>, <shot_quality>, <continuity> and <editing_style> stay
byte-identical to v2 (pinned in test_dub_prompts.py).
"""

import pathlib
from typing import Any

import pytest

from packages.video import dub_ai


def test_clip_bounds_required_only_on_the_fresh_edit_schema():
    assert dub_ai.DUB_EDIT_SCHEMA_VIDEO_BOUNDED["required"] == ["clipBounds", "segments"]
    item = dub_ai.DUB_EDIT_SCHEMA_VIDEO_BOUNDED["properties"]["clipBounds"]["items"]
    assert item["required"] == ["clip", "endsAt"]
    # The re-edit call shares the plain schema and its prompt never mentions
    # clipBounds — requiring a field the prompt does not explain invites the
    # model to invent one.
    assert dub_ai.DUB_EDIT_SCHEMA_VIDEO["required"] == ["segments"]
    assert "clipBounds" not in dub_ai.DUB_EDIT_SCHEMA_VIDEO["properties"]


def test_durations_reach_the_prompt_dynamically_never_hardcoded():
    ctx = dub_ai.build_dub_edit_context_text_video(
        brief="", user_script="", clip_durations=[("clip0", 291.7), ("clip1", 88.25)]
    )
    assert "clip0: 291.7s — valid timestamps 0.0 to 291.7" in ctx
    assert "clip1: 88.2s — valid timestamps 0.0 to 88.2" in ctx

    ins = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=[("clip0", 291.7), ("clip1", 88.25)]
    )
    assert "HARD LIMIT" in ins
    assert "every sourceIn and sourceOut for clip0 must be ≤ 291.7" in ins
    assert "every sourceIn and sourceOut for clip1 must be ≤ 88.2" in ins
    assert "clipBounds" in ins

    # A different clip must produce different numbers — proof the bound is
    # interpolated from the probe rather than baked into the prompt text.
    other = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=[("clip0", 42.0)]
    )
    assert "≤ 42.0" in other
    assert "291.7" not in other
    for system in (dub_ai.DUB_EDIT_SYSTEM_VIDEO, dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        assert "clipBounds" in system
        assert "291.7" not in system  # no literal duration anywhere in the prose


def test_guard_does_not_steer_attention_toward_the_end_of_the_clip():
    """An earlier draft told the model to "check this against your LAST
    segments" and to re-read <clips> before every segment. Both were removed:
    the guard constrains the answer, it must not redirect where the model
    looks for material."""
    for system in (dub_ai.DUB_EDIT_SYSTEM_VIDEO, dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        assert "Re-read the <clips> block before EVERY segment" not in system
    ins = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=[("clip0", 291.7)]
    )
    assert "not just your first" not in ins


def test_out_of_range_segments_reports_offenders_worst_first():
    script = {
        "segments": [
            {"sourceClip": "clip0", "sourceIn": 10.0, "sourceOut": 12.0},
            {"sourceClip": "clip0", "sourceIn": 442.0, "sourceOut": 445.5},
            {"sourceClip": "clip0", "sourceIn": 300.0, "sourceOut": 302.5},
            {"sourceClip": "clip1", "sourceIn": 5.0, "sourceOut": 7.0},
            {"sourceClip": "ghost", "sourceIn": 999.0, "sourceOut": 1000.0},
            "not-a-dict",
        ]
    }
    assert dub_ai.out_of_range_segments(script, {"clip0": 291.7, "clip1": 88.2}) == [
        445.5, 442.0, 302.5, 300.0
    ]
    assert dub_ai.out_of_range_segments({"segments": []}, {"clip0": 10.0}) == []


def _stub(monkeypatch, tmp_path, replies: list[str]):
    """Run generate_dub_edit_script_video against a scripted sequence of model
    replies; returns what was captured (messages per call, upload count)."""
    clip = tmp_path / "clip0.mp4"
    clip.write_bytes(b"fake")
    seen: dict[str, Any] = {"messages": [], "uploads": 0}

    async def fake_upload(path, *, mime_type="video/mp4"):
        seen["uploads"] += 1
        return "gemini-file://clip0.mp4"

    async def fake_delete(file_ids):
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        seen["messages"].append(messages)

        class _Resp:
            choices = [type("C", (), {"message": type("M", (), {
                "content": replies[len(seen["messages"]) - 1]
            })()})()]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr(
        "packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model}
    )
    return seen, clip


def _script(*times: tuple[float, float]) -> str:
    segs = ", ".join(
        '{"order": %d, "voiceoverLineId": %d, "sourceClip": "clip0", "sourceIn": %s, '
        '"sourceOut": %s, "matchedFrameTime": %s, "visualDescription": "x", "cutStyle": "jump_cut"}'
        % (i + 1, i + 1, a, b, a)
        for i, (a, b) in enumerate(times)
    )
    return '{"clipBounds": [{"clip": "clip0", "endsAt": 100.0}], "segments": [%s]}' % segs


IN_RANGE = [(1.0, 3.0), (10.0, 12.0), (20.0, 22.0), (30.0, 32.0), (40.0, 42.0)]
MOSTLY_OUT = [(1.0, 3.0), (150.0, 152.0), (200.0, 202.0), (442.0, 445.0), (300.0, 302.0)]


@pytest.mark.asyncio
async def test_no_retry_when_everything_fits(monkeypatch, tmp_path):
    seen, clip = _stub(monkeypatch, tmp_path, [_script(*IN_RANGE)])
    result = await dub_ai.generate_dub_edit_script_video(
        [("clip0", clip, 100.0)], brief="", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )
    assert len(seen["messages"]) == 1  # a good draw costs nothing extra
    assert len(result["segments"]) == 5


@pytest.mark.asyncio
async def test_retries_once_and_quotes_the_bad_timestamps(monkeypatch, tmp_path):
    seen, clip = _stub(monkeypatch, tmp_path, [_script(*MOSTLY_OUT), _script(*IN_RANGE)])
    result = await dub_ai.generate_dub_edit_script_video(
        [("clip0", clip, 100.0)], brief="", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )
    assert len(seen["messages"]) == 2
    assert seen["uploads"] == 1  # retry reuses the upload — inference only

    correction = seen["messages"][1][-1]["content"]
    assert "<correction>" in correction
    assert "4 of 5 segments outside the real footage" in correction
    assert "445.0s" in correction and "442.0s" in correction
    assert "clip0 ends at 100.0s" in correction
    assert len(result["segments"]) == 5  # the retry's better answer ships


@pytest.mark.asyncio
async def test_keeps_the_better_attempt_when_the_retry_is_worse(monkeypatch, tmp_path):
    """A retry that comes back worse must not replace a usable first answer."""
    seen, clip = _stub(
        monkeypatch, tmp_path,
        [_script(*MOSTLY_OUT), _script((1.0, 3.0), (500.0, 502.0), (600.0, 602.0))],
    )
    result = await dub_ai.generate_dub_edit_script_video(
        [("clip0", clip, 100.0)], brief="", user_script="", target_duration_sec=None,
        project_uid="p1", on_thinking=None,
    )
    assert len(seen["messages"]) == 2  # never more than one retry
    assert len(result["segments"]) == 1
    assert result["segments"][0]["sourceIn"] == 1.0


@pytest.mark.asyncio
async def test_bounded_schema_is_the_one_sent(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}
    clip = tmp_path / "clip0.mp4"
    clip.write_bytes(b"fake")

    async def fake_upload(path, *, mime_type="video/mp4"):
        return "gemini-file://clip0.mp4"

    async def fake_delete(file_ids):
        return None

    async def fake_stream(messages, *, system, project_uid, on_thinking, **kwargs):
        captured.update(kwargs)

        class _Resp:
            choices = [
                type("C", (), {"message": type("M", (), {"content": _script(*IN_RANGE)})()})()
            ]

        return _Resp()

    monkeypatch.setattr("packages.llm.files.upload_gemini_file", fake_upload)
    monkeypatch.setattr("packages.llm.files.delete_gemini_files", fake_delete)
    monkeypatch.setattr("packages.llm.gateway.acompletion_stream_thinking", fake_stream)
    monkeypatch.setattr(
        "packages.llm.config.call_kwargs", lambda model=None, effort=None: {"model": model}
    )

    await dub_ai.generate_dub_edit_script_video(
        [("clip0", pathlib.Path(clip), 100.0)], brief="", user_script="",
        target_duration_sec=None, project_uid="p1", on_thinking=None,
    )
    assert captured["response_format"]["response_schema"] == dub_ai.DUB_EDIT_SCHEMA_VIDEO_BOUNDED
