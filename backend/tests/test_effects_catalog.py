"""Tests for the effects component catalog + AI sanitize logic."""

from __future__ import annotations

from packages.video.effects_ai import _build_user_text, _sanitize
from packages.video.effects_catalog import (
    catalog_prompt_text,
    component_catalog,
    known_component_ids,
    normalize_props_for_component,
)
from packages.video.transforms import TRANSFORM_REGISTRY


def test_catalog_includes_overlays_and_transforms() -> None:
    ids = known_component_ids()
    assert {"text-reveal", "sticker-badge"} <= ids  # overlays
    assert set(TRANSFORM_REGISTRY) <= ids  # transforms not dropped


def test_catalog_transform_half_matches_registry() -> None:
    # Guard against drift: every registered transform appears in the catalog.
    catalog_transform_ids = {c["componentId"] for c in component_catalog() if c["kind"] == "transform"}
    assert catalog_transform_ids == set(TRANSFORM_REGISTRY)


def test_prompt_text_lists_components_and_props() -> None:
    text = catalog_prompt_text()
    assert "sticker-badge" in text
    assert "punch-zoom" in text
    assert "kind=overlay" in text
    assert "kind=transform" in text


def test_normalize_props_renames_known_synonym() -> None:
    # sticker-badge's real key is "label"; the model sometimes writes "text".
    out = normalize_props_for_component("sticker-badge", {"text": "ลด 70%", "x": 0.5})
    assert out == {"label": "ลด 70%", "x": 0.5}


def test_normalize_props_drops_unknown_keys() -> None:
    # lottie-sticker has no "url" prop — an invented remote-URL key must not
    # reach the renderer (it isn't fetched and would just be dead weight).
    out = normalize_props_for_component("lottie-sticker", {"x": 0.5, "url": "https://example.com/a.json"})
    assert out == {"x": 0.5}


def test_normalize_props_renames_punch_zoom_scale() -> None:
    # observed repeatedly on live Gemini calls: model writes "scale" instead
    # of the real key "zoomTo" — must not be silently dropped.
    out = normalize_props_for_component("punch-zoom", {"scale": 1.3, "focusX": 0.5})
    assert out == {"zoomTo": 1.3, "focusX": 0.5}


def test_normalize_props_does_not_cross_contaminate_components() -> None:
    # text-reveal's real key IS "text" — must not be renamed away.
    out = normalize_props_for_component("text-reveal", {"text": "ลดราคา"})
    assert out == {"text": "ลดราคา"}


def test_sanitize_end_to_end_fixes_prop_key_mismatch() -> None:
    raw = {
        "instances": [
            {
                "kind": "overlay",
                "componentId": "sticker-badge",
                "startSec": 1.0,
                "durationSec": 2.0,
                "propsJson": '{"text": "ลด 70%", "x": 0.5}',
            }
        ]
    }
    doc = _sanitize(raw, duration_sec=30.0)
    assert doc.instances[0].props == {"label": "ลด 70%", "x": 0.5}


def test_sanitize_merges_top_level_focus_into_punch_zoom_props() -> None:
    # focusX/focusY are top-level schema fields (Gemini kept dropping them from
    # inside propsJson even when the prompt demanded them) — must land in props.
    raw = {
        "instances": [
            {
                "kind": "transform",
                "componentId": "punch-zoom",
                "startSec": 1.0,
                "durationSec": 2.0,
                "propsJson": '{"zoomTo": 1.5}',
                "focusX": 0.2,
                "focusY": 0.8,
            }
        ]
    }
    doc = _sanitize(raw, duration_sec=30.0)
    assert doc.instances[0].props == {"zoomTo": 1.5, "focusX": 0.2, "focusY": 0.8}


def test_sanitize_clamps_focus_to_0_1() -> None:
    raw = {
        "instances": [
            {
                "kind": "transform",
                "componentId": "punch-zoom",
                "startSec": 0.0,
                "durationSec": 1.0,
                "propsJson": "{}",
                "focusX": 1.7,
                "focusY": -0.3,
            }
        ]
    }
    doc = _sanitize(raw, duration_sec=10.0)
    assert doc.instances[0].props == {"focusX": 1.0, "focusY": 0.0}


def test_sanitize_ignores_focus_for_non_punch_zoom() -> None:
    raw = {
        "instances": [
            {
                "kind": "overlay",
                "componentId": "sticker-badge",
                "startSec": 0.0,
                "durationSec": 1.0,
                "propsJson": '{"label": "hi"}',
                "focusX": 0.5,
                "focusY": 0.5,
            }
        ]
    }
    doc = _sanitize(raw, duration_sec=10.0)
    assert doc.instances[0].props == {"label": "hi"}


def test_sanitize_drops_unknown_components() -> None:
    raw = {
        "instances": [
            {"kind": "overlay", "componentId": "sticker-badge", "startSec": 1.0, "durationSec": 2.0},
            {"kind": "overlay", "componentId": "made-up", "startSec": 1.0, "durationSec": 2.0},
        ]
    }
    doc = _sanitize(raw, duration_sec=30.0)
    assert [i.componentId for i in doc.instances] == ["sticker-badge"]
    assert doc.instances[0].source == "ai"


def test_sanitize_clamps_window_to_clip() -> None:
    raw = {
        "instances": [
            # starts before end but overruns → duration trimmed to fit
            {"kind": "overlay", "componentId": "text-reveal", "startSec": 9.0, "durationSec": 5.0},
            # starts past the end → dropped entirely
            {"kind": "overlay", "componentId": "text-reveal", "startSec": 12.0, "durationSec": 2.0},
        ]
    }
    doc = _sanitize(raw, duration_sec=10.0)
    assert len(doc.instances) == 1
    assert doc.instances[0].startSec == 9.0
    assert abs(doc.instances[0].durationSec - 1.0) < 1e-6


def test_build_user_text_includes_prompt_and_length() -> None:
    txt = _build_user_text(brief="รองเท้า", user_prompt="เยอะๆ playful", duration_sec=42.5)
    assert "42.5 seconds" in txt
    assert "playful" in txt
    assert "รองเท้า" in txt


def test_build_user_text_handles_empty() -> None:
    txt = _build_user_text(brief="", user_prompt="", duration_sec=10.0)
    assert "(none" in txt
    assert "<script>" not in txt


def test_build_user_text_includes_script_lines() -> None:
    txt = _build_user_text(
        brief="",
        user_prompt="",
        duration_sec=20.0,
        script_lines="0.0s-3.0s: ลดราคาวันนี้\n3.0s-6.0s: รองเท้าคู่นี้ดีมาก",
    )
    assert "<script>" in txt
    assert "ลดราคาวันนี้" in txt
    assert "match effects to the exact words" in txt
