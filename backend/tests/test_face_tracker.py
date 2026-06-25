"""Unit tests for face tracker helper functions (no real video/camera required)."""

import pytest

from packages.video.face_tracker import (
    build_ffmpeg_crop_filter,
    median_face_crop,
)


def _make_face(cx=0.5, cy=0.4, w=0.15, h=0.2):
    return {"cx": cx, "cy": cy, "w": w, "h": h}


def _make_results(bboxes):
    return [{"frame_idx": i * 30, "time_sec": i, "bbox": b} for i, b in enumerate(bboxes)]


def test_median_face_crop_returns_none_when_too_few():
    results = _make_results([_make_face()])  # only 1 face → need ≥2
    assert median_face_crop(results, 1080, 1920) is None


def test_median_face_crop_returns_none_when_no_faces():
    results = _make_results([None, None, None])
    assert median_face_crop(results, 1080, 1920) is None


def test_median_face_crop_basic():
    # Face centered at (0.5, 0.4) of a 1080x1920 frame
    results = _make_results([_make_face(0.5, 0.4), _make_face(0.5, 0.4), _make_face(0.5, 0.4)])
    crop = median_face_crop(results, 1080, 1920)
    assert crop is not None
    assert crop["w"] > 0 and crop["h"] > 0
    assert crop["x"] >= 0 and crop["y"] >= 0
    assert crop["x"] + crop["w"] <= 1080
    assert crop["y"] + crop["h"] <= 1920


def test_median_face_crop_aspect_ratio():
    results = _make_results([_make_face(0.5, 0.4)] * 3)
    crop = median_face_crop(results, 1080, 1920)
    assert crop is not None
    # crop should approximate 9:16
    ratio = crop["w"] / crop["h"]
    assert abs(ratio - 9 / 16) < 0.05


def test_median_face_crop_clamped_to_frame():
    # Face near left edge
    results = _make_results([_make_face(0.05, 0.4)] * 3)
    crop = median_face_crop(results, 1080, 1920)
    assert crop is not None
    assert crop["x"] >= 0


def test_build_crop_filter_format():
    crop = {"x": 100, "y": 50, "w": 540, "h": 960}
    result = build_ffmpeg_crop_filter(crop)
    assert result == "crop=540:960:100:50"


def test_median_with_mixed_none_and_faces():
    results = _make_results([None, _make_face(0.5, 0.4), None, _make_face(0.5, 0.4)])
    crop = median_face_crop(results, 1080, 1920)
    assert crop is not None
