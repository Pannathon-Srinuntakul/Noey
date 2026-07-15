"""Tests for effect transforms (packages/video/transforms.py)."""

from __future__ import annotations

from packages.video.transforms import (
    TRANSFORM_REGISTRY,
    _as_bool,
    punch_zoom_filter,
    transform_entry,
)


def test_as_bool_parses_string_enums() -> None:
    # JSON-schema enum booleans arrive as strings; bool('false') is True, so
    # the coercion must special-case the string form.
    assert _as_bool("false", True) is False
    assert _as_bool("true", False) is True
    assert _as_bool(False, True) is False
    assert _as_bool(True, False) is True
    assert _as_bool(None, True) is True
    assert _as_bool("0", True) is False


def test_registry_has_punch_zoom_with_prop_schema() -> None:
    entry = transform_entry("punch-zoom")
    assert entry is not None
    assert callable(entry["builder"])
    assert set(entry["propSchema"]) >= {"zoomFrom", "zoomTo", "focusX", "focusY"}


def test_unknown_transform_returns_none() -> None:
    assert transform_entry("nope") is None


def test_punch_zoom_filter_shape() -> None:
    f = punch_zoom_filter(
        {"zoomTo": 1.5, "focusX": 0.5, "focusY": 0.4},
        width=1080,
        height=1920,
        start_sec=1.0,
        end_sec=3.0,
        fps=30,
    )
    assert f.startswith("zoompan=")
    assert "s=1080x1920" in f
    assert "fps=30" in f
    # gated on the window so frames outside [start,end] stay at zoom 1
    assert "between(ot,1.0,3.0)" in f


def test_punch_zoom_hold_vs_return() -> None:
    hold = punch_zoom_filter({"hold": True}, width=100, height=100, start_sec=0, end_sec=2)
    ret = punch_zoom_filter({"hold": False}, width=100, height=100, start_sec=0, end_sec=2)
    # the return variant adds an exit ramp (an extra conditional), hold does not
    assert "gt(ot," not in hold
    assert "gt(ot," in ret


def test_punch_zoom_clamps_out_of_range_props() -> None:
    # zoomTo way over max should clamp to 4.0, not explode the expression
    f = punch_zoom_filter({"zoomTo": 99}, width=100, height=100, start_sec=0, end_sec=2)
    assert "4.0" in f
    assert "99" not in f


def test_all_registered_transforms_build_valid_string() -> None:
    for _cid, entry in TRANSFORM_REGISTRY.items():
        out = entry["builder"]({}, width=720, height=1280, start_sec=0.0, end_sec=1.5)
        assert isinstance(out, str) and out
