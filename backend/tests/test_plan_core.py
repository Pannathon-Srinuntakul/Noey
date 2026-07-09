"""Extracted talking_head planning core — behavior guard after tasks.py refactor.

There is only one behavior now (Gemini review happens upstream, per-clip, inside
whisper_client.run_transcription before segments/silence_gaps ever reach this
module) — build_talking_head_timeline itself makes no LLM calls and no longer
branches on duration_mode; that field is accepted only for backward DB
compatibility with legacy rows.
"""

from __future__ import annotations

from typing import Any

import pytest

from packages.video import plan_core

TRANSCRIPT_SEGMENTS = [
    {"start": 0.5, "end": 3.0, "text": "สวัสดีค่ะ วันนี้มารีวิวเสื้อตัวใหม่",
     "words": [{"word": "สวัสดีค่ะ", "start": 0.5, "end": 1.2},
               {"word": "วันนี้มารีวิวเสื้อตัวใหม่", "start": 1.4, "end": 3.0}]},
    {"start": 6.0, "end": 9.5, "text": "เนื้อผ้าดีมาก ใส่สบาย",
     "words": [{"word": "เนื้อผ้าดีมาก", "start": 6.0, "end": 7.5},
               {"word": "ใส่สบาย", "start": 8.0, "end": 9.5}]},
    {"start": 12.0, "end": 14.0, "text": "สั่งได้เลยที่ TikTok Shop",
     "words": [{"word": "สั่งได้เลยที่", "start": 12.0, "end": 13.0},
               {"word": "TikTok Shop", "start": 13.2, "end": 14.0}]},
]


async def _boom(*a: Any, **k: Any) -> str:
    raise AssertionError("build_talking_head_timeline must never call an LLM directly")


@pytest.mark.asyncio
async def test_builds_timeline_without_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """All content decisions happen upstream (Gemini review) — this is pure assembly."""
    monkeypatch.setattr("packages.llm.gateway.complete", _boom)

    progress_msgs: list[str] = []

    async def _progress(msg: str) -> None:
        progress_msgs.append(msg)

    timeline = await plan_core.build_talking_head_timeline(
        TRANSCRIPT_SEGMENTS,
        duration_mode="full",
        target_duration_sec=None,
        clip_durations=[20.0],
        source_info={"width": 1080, "height": 1920, "fps": 30},
        sources=[{"id": "clip0", "file": "normalized/norm_000.mp4"}],
        on_progress=_progress,
    )

    assert timeline["mode"] == "talking_head"
    assert timeline["editMode"] == "full"
    assert timeline["output"]["targetDurationSec"] is None
    assert timeline["output"]["clipCount"] == 1
    assert timeline["output"]["width"] == 1080
    assert len(timeline["timeline"]) >= 1
    for cut in timeline["timeline"]:
        assert cut["out"] > cut["in"] >= 0
    assert len(timeline["captions"]) >= 1
    assert progress_msgs == ["กำลังประกอบไทม์ไลน์…"]


@pytest.mark.asyncio
async def test_legacy_duration_mode_values_still_run_full(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rows saved before this change may still say "custom"/"auto" — must degrade to full, not error."""
    monkeypatch.setattr("packages.llm.gateway.complete", _boom)

    for legacy_mode in ("custom", "auto", None):
        timeline = await plan_core.build_talking_head_timeline(
            TRANSCRIPT_SEGMENTS,
            duration_mode=legacy_mode,
            target_duration_sec=30,
            clip_durations=[20.0],
            source_info={"width": 720, "height": 1280, "fps": 30},
            sources=[{"id": "clip0", "file": "normalized/norm_000.mp4"}],
        )
        assert timeline["editMode"] == "full"
        assert timeline["output"]["targetDurationSec"] is None  # legacy target ignored, not honored


@pytest.mark.asyncio
async def test_silence_gaps_merged_in_as_kept_cuts() -> None:
    """A Gemini-approved silent span becomes its own cut alongside the speech cuts."""
    # Segments span [0.5-3.0] and [6.0-9.5] and [12.0-14.0]; the gap between the
    # first two speech cuts is a real candidate span worth testing the merge on.
    timeline = await plan_core.build_talking_head_timeline(
        TRANSCRIPT_SEGMENTS,
        duration_mode="full",
        target_duration_sec=None,
        clip_durations=[20.0],
        source_info={"width": 1080, "height": 1920, "fps": 30},
        sources=[{"id": "clip0", "file": "normalized/norm_000.mp4"}],
        silence_gaps=[{"in": 3.0, "out": 6.0}],
    )
    cuts = timeline["timeline"]
    # The kept silence span should show up somewhere in the final localized cuts,
    # bridging what would otherwise be a gap between the first two speech blocks.
    covers_gap = any(c["in"] <= 3.5 and c["out"] >= 5.5 for c in cuts) or any(
        c["in"] < 6.0 and c["out"] > 3.0 for c in cuts
    )
    assert covers_gap, f"expected a cut covering the kept silence gap, got {cuts}"


@pytest.mark.asyncio
async def test_empty_transcript_raises() -> None:
    with pytest.raises(ValueError, match="no speech segments"):
        await plan_core.build_talking_head_timeline(
            [],
            duration_mode="full",
            target_duration_sec=None,
            clip_durations=[10.0],
            source_info={"width": 0, "height": 0, "fps": 30},
            sources=[],
        )


def test_plan_talking_local_registered() -> None:
    from services.worker.tasks import WorkerSettings, plan_talking_local

    assert plan_talking_local in WorkerSettings.functions
