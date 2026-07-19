"""Tests for effect transforms (packages/video/transforms.py)."""

from __future__ import annotations

from packages.video.transforms import (
    TRANSFORM_REGISTRY,
    _as_bool,
    punch_zoom_filter,
    scene_drift_filter,
    transform_entry,
    whip_pan_filter,
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
    assert f.startswith("scale=w=iw*4:h=ih*4,zoompan=")
    assert "s=1080x1920" in f
    assert "fps=30" in f
    # gated on the half-open window [start,end) so the end frame (often a cut) is clean
    assert "gte(ot,1.0)*lt(ot,3.0)" in f


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


def test_punch_zoom_cut_is_a_pure_step_no_ramp() -> None:
    # A genuine hard cut to a different crop — no interpolation expression at
    # all (not even the 0.05s floor used for non-cut zooms), so there is no
    # in-between frame regardless of what rampSec/zoomFrom the caller sends.
    cut = punch_zoom_filter(
        {"zoomTo": 1.4, "cut": True, "rampSec": 3.0, "zoomFrom": 2.0},
        width=100, height=100, start_sec=1.0, end_sec=3.0,
    )
    assert "min(1,(ot-" not in cut  # no ramp interpolation expression
    assert "if(gte(ot,1.0)*lt(ot,3.0),1.4,1)" in cut
    assert "2.0" not in cut  # zoomFrom is unused for a cut


def test_punch_zoom_cut_with_hold_false_eases_the_release() -> None:
    # Entry stays an instant cut (no in-between frame at the start), but the
    # release — a deliberate mid-scene release with no real cut underneath —
    # eases back to normal instead of snapping, or it reads as a fake cut.
    f = punch_zoom_filter(
        {"zoomTo": 1.4, "cut": True, "hold": False},
        width=100, height=100, start_sec=0.0, end_sec=4.0,
    )
    assert "if(gt(ot," in f  # exit-ramp branch present
    assert "min(1,(ot-" in f  # interpolation expression for the release


def test_punch_zoom_cut_false_keeps_ramp_behavior() -> None:
    f = punch_zoom_filter(
        {"zoomTo": 1.4, "cut": False, "rampSec": 0.5}, width=100, height=100, start_sec=0, end_sec=2
    )
    assert "min(1,(ot-" in f


def test_registry_punch_zoom_has_cut_prop() -> None:
    entry = transform_entry("punch-zoom")
    assert entry is not None
    assert "cut" in entry["propSchema"]


def test_registry_has_whip_pan_with_prop_schema() -> None:
    entry = transform_entry("whip-pan")
    assert entry is not None
    assert callable(entry["builder"])
    assert set(entry["propSchema"]) == {"direction", "intensity"}


def test_whip_pan_filter_shape() -> None:
    f = whip_pan_filter(
        {"direction": "horizontal", "intensity": 0.7},
        width=1080, height=1920, start_sec=9.85, end_sec=10.15, fps=30,
    )
    assert f.startswith("scale=w=iw*4:h=ih*4,zoompan=")
    assert "s=1080x1920" in f
    # centered on the window midpoint (the real cut instant)
    assert "10.0" in f
    assert "between(ot,9.85,10.15)" in f


def test_whip_pan_filter_vertical_biases_y_not_x() -> None:
    f = whip_pan_filter(
        {"direction": "vertical", "intensity": 0.5},
        width=1080, height=1920, start_sec=0.0, end_sec=0.3,
    )
    assert "x='(iw-iw/zoom)/2'" in f
    assert "y='(ih-ih/zoom)*(0.5+0.5*sign" in f


def test_punch_zoom_no_drift_is_static_focus() -> None:
    # No driftX/driftY given -> focus expression is a plain constant, not a
    # time-varying one (previous, unchanged behavior).
    f = punch_zoom_filter(
        {"focusX": 0.3, "focusY": 0.7}, width=100, height=100, start_sec=0, end_sec=2,
    )
    assert "x='(iw-iw/zoom)*0.3'" in f
    assert "y='(ih-ih/zoom)*0.7'" in f


def test_punch_zoom_with_drift_pans_during_hold() -> None:
    f = punch_zoom_filter(
        {"focusX": 0.2, "focusY": 0.5, "driftX": 0.8, "driftY": 0.5, "hold": True, "rampSec": 0.4},
        width=100, height=100, start_sec=1.0, end_sec=4.0,
    )
    # Drift only kicks in once given and different from focus; expression
    # becomes time-varying (references ot), gated to start after the ramp.
    assert "0.8-0.2" in f or "0.2+(0.8-0.2)" in f
    assert "ot-(1.0+0.4)" in f


def test_punch_zoom_drift_equal_to_focus_stays_static() -> None:
    # Model setting driftX/driftY == focusX/focusY (the documented "plain
    # static hold" case) must not produce a needlessly time-varying expr.
    f = punch_zoom_filter(
        {"focusX": 0.5, "focusY": 0.5, "driftX": 0.5, "driftY": 0.5},
        width=100, height=100, start_sec=0, end_sec=2,
    )
    assert "x='(iw-iw/zoom)*0.5'" in f
    assert "y='(ih-ih/zoom)*0.5'" in f


def test_registry_has_scene_drift_with_prop_schema() -> None:
    entry = transform_entry("scene-drift")
    assert entry is not None
    assert callable(entry["builder"])
    assert set(entry["propSchema"]) == {
        "zoomFrom", "zoomTo", "focusFromX", "focusFromY", "focusToX", "focusToY",
    }


def test_scene_drift_filter_spans_whole_window_no_plateau() -> None:
    f = scene_drift_filter(
        {"zoomFrom": 1.0, "zoomTo": 1.15}, width=1080, height=1920, start_sec=5.0, end_sec=12.0,
    )
    assert f.startswith("scale=w=iw*4:h=ih*4,zoompan=")
    # progress expression covers the full [start,end] span, not a short ramp.
    assert "(ot-5.0)/7.0" in f or "(ot-5.0)/" in f
    assert "gte(ot,5.0)*lt(ot,12.0)" in f


def test_scene_drift_filter_clamps_mild_zoom_range() -> None:
    # scene-drift's zoom range is deliberately mild (1.0-1.6), unlike
    # punch-zoom's up to 4.0 — a huge requested zoom must clamp down.
    f = scene_drift_filter(
        {"zoomFrom": 1.0, "zoomTo": 9.0}, width=100, height=100, start_sec=0, end_sec=3,
    )
    assert "1.6" in f
    assert "9.0" not in f


def test_zoompan_transforms_prescale_for_precision() -> None:
    # Regression (2026-07-18, live report: "zoom สั่นๆไปหมด"): a slow,
    # continuous zoom's per-frame delta is tiny, so zoompan's integer-pixel
    # crop rounding was visibly jittery. Every zoompan-based transform must
    # pre-upscale before zoompan so the crop math has sub-pixel headroom.
    for name, builder in (
        ("punch-zoom", punch_zoom_filter),
        ("whip-pan", whip_pan_filter),
        ("scene-drift", scene_drift_filter),
    ):
        f = builder({}, width=1080, height=1920, start_sec=0.0, end_sec=2.0)
        assert f.startswith("scale=w=iw*4:h=ih*4,zoompan="), f"{name}: {f[:60]}"


def test_zoompan_transforms_no_tmix_enable() -> None:
    # Regression (2026-07-18): `tmix=...:enable=between(t,...)` after zoompan
    # turns the whole frame neon green on yuv420p. Prescale-only is the safe path.
    for name, builder in (
        ("punch-zoom", punch_zoom_filter),
        ("whip-pan", whip_pan_filter),
        ("scene-drift", scene_drift_filter),
    ):
        f = builder({}, width=1080, height=1920, start_sec=3.0, end_sec=9.0)
        assert "tmix=" not in f, f"{name}: {f}"
        assert f.startswith("scale=w=iw*4:h=ih*4,zoompan="), f"{name}: {f[:80]}"


def test_all_registered_transforms_build_valid_string() -> None:
    for _cid, entry in TRANSFORM_REGISTRY.items():
        out = entry["builder"]({}, width=720, height=1280, start_sec=0.0, end_sec=1.5)
        assert isinstance(out, str) and out
