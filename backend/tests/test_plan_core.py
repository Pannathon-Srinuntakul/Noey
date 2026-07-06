"""Extracted talking_head planning core — behavior guard after tasks.py refactor."""

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


@pytest.mark.asyncio
async def test_full_mode_builds_timeline_without_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """duration_mode=full is pure code — any LLM call would be a regression."""

    async def _boom(*a: Any, **k: Any) -> str:
        raise AssertionError("full mode must not call the LLM")

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
    assert progress_msgs == ["ตัดช่วงเงียบ + ลบคำพูดซ้ำ…"]


@pytest.mark.asyncio
async def test_custom_mode_uses_haiku_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    prompts: list[tuple[str, str]] = []

    async def fake_complete(prompt: str, *, system: str) -> str:
        prompts.append((system[:40], prompt[:60]))
        if "targetSec" in prompt:
            return '{"keep": [0, 1, 2], "remove_reason": {}}'
        return '{"duplicate_groups": []}'

    monkeypatch.setattr("packages.llm.gateway.complete", fake_complete)

    timeline = await plan_core.build_talking_head_timeline(
        TRANSCRIPT_SEGMENTS,
        duration_mode="custom",
        target_duration_sec=30,
        clip_durations=[20.0],
        source_info={"width": 720, "height": 1280, "fps": 30},
        sources=[{"id": "clip0", "file": "normalized/norm_000.mp4"}],
    )

    assert timeline["editMode"] == "highlight"
    assert timeline["output"]["targetDurationSec"] == 30
    assert len(timeline["timeline"]) >= 1
    # highlight selection prompt was sent
    assert any("targetSec" in p for _, p in prompts)


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


@pytest.mark.asyncio
async def test_clean_transcript_short_text_skips_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*a: Any, **k: Any) -> str:
        raise AssertionError("short transcript must not call the LLM")

    monkeypatch.setattr("packages.llm.gateway.complete", _boom)
    segs = [{"start": 0, "end": 1, "text": "สั้น"}]
    assert await plan_core.clean_transcript_with_llm(segs) == segs


@pytest.mark.asyncio
async def test_clean_transcript_applies_corrections(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_complete(prompt: str, *, system: str) -> str:
        return '[{"i": 0, "t": "ข้อความที่แก้แล้ว"}]'

    monkeypatch.setattr("packages.llm.gateway.complete", fake_complete)
    segs = [{"start": 0.0, "end": 2.0, "text": "ก" * 60, "words": []}]
    out = await plan_core.clean_transcript_with_llm(segs)
    assert out[0]["text"] == "ข้อความที่แก้แล้ว"
    assert out[0]["start"] == 0.0  # timing preserved


def test_worker_aliases_point_at_plan_core() -> None:
    from services.worker import tasks

    assert tasks._clean_transcript_with_llm is plan_core.clean_transcript_with_llm
    assert tasks._plan_highlight_with_haiku is plan_core.plan_highlight_with_haiku
    assert tasks._dedupe_semantic_cuts_with_llm is plan_core.dedupe_semantic_cuts_with_llm


def test_plan_talking_local_registered() -> None:
    from services.worker.tasks import WorkerSettings, plan_talking_local

    assert plan_talking_local in WorkerSettings.functions
