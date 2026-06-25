"""Tests for duration-based dub_first Vision sample budget."""

import pathlib
from unittest.mock import patch

from packages.video.scene import (
    DUB_MAX_CLIP_SEC,
    DUB_SCENE_INTERVAL_SEC,
    budget_sample_windows,
    build_vision_content,
    dub_sample_frame_budget,
    dub_scene_cap,
    extract_cut_boost_frames,
    _timestamp_is_near,
)


def test_dub_scene_cap_scales_with_duration() -> None:
    assert dub_scene_cap(41) == 3
    assert dub_scene_cap(60) == 4
    assert dub_scene_cap(180) == 12  # 3 min
    assert dub_scene_cap(300) == 20  # 5 min
    assert dub_scene_cap(600) == 40  # 10 min
    assert dub_scene_cap(1200) == 80  # 20 min


def test_dub_scene_cap_clamps_at_max_clip() -> None:
    assert dub_scene_cap(1200) == dub_scene_cap(1500)
    assert dub_scene_cap(1500) == round(DUB_MAX_CLIP_SEC / DUB_SCENE_INTERVAL_SEC)


def test_dub_sample_frame_budget_doubles_per_scene() -> None:
    assert dub_sample_frame_budget(300) == dub_scene_cap(300) * 2
    assert dub_sample_frame_budget(1200) == 160


def test_budget_sample_windows_covers_full_clip() -> None:
    windows = budget_sample_windows(146.0)
    assert len(windows) == dub_scene_cap(146.0)
    assert windows[0]["start"] == 0.0
    assert windows[-1]["end"] == 146.0
    assert sum(w["duration"] for w in windows) == 146.0


def test_budget_sample_windows_one_take_gets_many_slots() -> None:
    """One-take 146s clip should yield 10 slots × 2 samples = 20 budget frames (not 2)."""
    assert dub_scene_cap(146.0) == 10
    assert dub_sample_frame_budget(146.0) == 20
    assert len(budget_sample_windows(146.0)) == 10


def test_short_clip_no_min_floor() -> None:
    assert dub_scene_cap(41.4) == 3
    assert dub_sample_frame_budget(41.4) == 6


def test_timestamp_is_near_dedupes() -> None:
    assert _timestamp_is_near(10.0, [10.4])
    assert not _timestamp_is_near(10.0, [11.0])


def test_cut_boost_skipped_for_single_scene() -> None:
    frames = extract_cut_boost_frames(
        pathlib.Path("clip.mp4"),
        [{"start": 0.0, "end": 100.0, "duration": 100.0}],
        pathlib.Path("."),
        "clip0",
        [],
    )
    assert frames == []


def test_build_vision_content_stats(tmp_path: pathlib.Path) -> None:
    img = tmp_path / "a.jpg"
    img.write_bytes(b"\xff\xd8" + b"x" * 100)
    frames = [{"frame_path": str(img), "time": 1.5, "clip_id": "clip0", "scene_idx": 0}]
    content, stats = build_vision_content(frames)
    assert len(content) == 1
    assert stats["image_blocks"] == 1
    assert stats["jpeg_bytes"] == 102
    assert stats["timestamps"] == [1.5]


def test_cut_boost_adds_after_first_scene_start() -> None:
    scenes = [
        {"start": 0.0, "end": 45.0, "duration": 45.0},
        {"start": 45.0, "end": 90.0, "duration": 45.0},
        {"start": 90.0, "end": 120.0, "duration": 30.0},
    ]
    with patch("packages.video.scene.run_ffmpeg"):
        frames = extract_cut_boost_frames(
            pathlib.Path("clip.mp4"),
            scenes,
            pathlib.Path("."),
            "clip0",
            existing_times=[0.0, 15.0],
        )
    assert len(frames) == 2
    assert frames[0]["time"] == 45.35
    assert frames[1]["time"] == 90.35
    assert all(f.get("edge") == "hard_cut" for f in frames)
