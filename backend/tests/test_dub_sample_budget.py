"""Tests for duration-based dub_first Vision sample budget."""

import math
import pathlib

from packages.video.scene import (
    DUB_MAX_BUDGET_FRAMES,
    DUB_MAX_CLIP_SEC,
    DUB_SCENE_INTERVAL_SEC,
    DUB_UPLOAD_TOLERANCE_SEC,
    budget_sample_windows,
    build_vision_content,
    dub_clip_exceeds_upload_limit,
    dub_sample_frame_budget,
    dub_scene_cap,
)


def test_dub_scene_cap_scales_with_duration() -> None:
    assert dub_scene_cap(41) == 3
    assert dub_scene_cap(60) == 4
    assert dub_scene_cap(150) == 10  # 2.5 min — under cap
    assert dub_scene_cap(300) == 20  # 5 min — under cap
    assert dub_scene_cap(450) == 30  # 7.5 min — hits DUB_MAX_BUDGET_FRAMES cap
    assert dub_scene_cap(600) == 30  # 10 min — capped


def test_dub_scene_cap_clamps_at_max_clip() -> None:
    assert dub_scene_cap(1200) == dub_scene_cap(DUB_MAX_CLIP_SEC)
    assert dub_scene_cap(DUB_MAX_CLIP_SEC) == DUB_MAX_BUDGET_FRAMES  # 30


def test_dub_sample_frame_budget_one_per_slot() -> None:
    assert dub_sample_frame_budget(41.4) == 3
    assert dub_sample_frame_budget(150) == 10
    assert dub_sample_frame_budget(600) == 30


def test_budget_sample_windows_covers_full_clip() -> None:
    windows = budget_sample_windows(146.0)
    assert len(windows) == dub_scene_cap(146.0)
    assert windows[0]["start"] == 0.0
    assert windows[-1]["end"] == 146.0
    assert sum(w["duration"] for w in windows) == 146.0


def test_longer_clip_gets_more_slots() -> None:
    assert dub_scene_cap(150) < dub_scene_cap(600)


def test_upload_limit_allows_ten_minute_rounding() -> None:
    assert not dub_clip_exceeds_upload_limit(600.0)
    assert not dub_clip_exceeds_upload_limit(600.8)
    assert not dub_clip_exceeds_upload_limit(DUB_MAX_CLIP_SEC + DUB_UPLOAD_TOLERANCE_SEC)
    assert dub_clip_exceeds_upload_limit(DUB_MAX_CLIP_SEC + DUB_UPLOAD_TOLERANCE_SEC + 0.1)


def test_build_vision_content_stats(tmp_path: pathlib.Path) -> None:
    img = tmp_path / "a.jpg"
    img.write_bytes(b"\xff\xd8" + b"x" * 100)
    frames = [{"frame_path": str(img), "time": 1.5, "clip_id": "clip0", "scene_idx": 0}]
    content, stats = build_vision_content(frames)
    assert len(content) == 1
    assert stats["image_blocks"] == 1
    assert stats["jpeg_bytes"] == 102
    assert stats["timestamps"] == [1.5]
