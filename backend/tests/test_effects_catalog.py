"""Tests for the effects component catalog + AI sanitize logic."""

from __future__ import annotations

from packages.video.effects_ai import _build_user_text, _zoom_ramp_sec
from packages.video.effects_catalog import (
    catalog_prompt_text,
    component_catalog,
    known_component_ids,
    missing_required_content_key,
    normalize_props_for_component,
)
from packages.video.transforms import TRANSFORM_REGISTRY


def test_catalog_includes_overlays_and_transforms() -> None:
    ids = known_component_ids()
    assert {"callout", "text-neon"} <= ids  # overlays
    assert set(TRANSFORM_REGISTRY) <= ids  # transforms not dropped


def test_catalog_transform_half_matches_registry() -> None:
    # Guard against drift: every registered transform appears in the catalog.
    catalog_transform_ids = {c["componentId"] for c in component_catalog() if c["kind"] == "transform"}
    assert catalog_transform_ids == set(TRANSFORM_REGISTRY)


def test_prompt_text_lists_components_and_props() -> None:
    text = catalog_prompt_text()
    assert "callout" in text
    assert "punch-zoom" in text
    assert "kind=overlay" in text
    assert "kind=transform" in text


def test_normalize_props_renames_known_synonym() -> None:
    # callout's real key is "label"; the model sometimes writes "text".
    out = normalize_props_for_component("callout", {"text": "ลด 70%", "x": 0.5})
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
    # text-neon's real key IS "text" — must not be renamed away.
    out = normalize_props_for_component("text-neon", {"text": "ลดราคา"})
    assert out == {"text": "ลดราคา"}


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


# ── frame-safety clamps (normalize_props_for_component) ─────────────────────


def test_normalize_clamps_position_into_safe_range() -> None:
    from packages.video.effects_catalog import normalize_props_for_component

    out = normalize_props_for_component("shape-kit", {"x": 1.5, "y": -0.2, "size": 300})
    assert out["x"] == 0.97
    assert out["y"] == 0.03


def test_normalize_clamps_numeric_bounds() -> None:
    from packages.video.effects_catalog import normalize_props_for_component

    out = normalize_props_for_component("shape-kit", {"size": 5000, "x": 0.5, "y": 0.5})
    assert out["size"] == 800

    zoom = normalize_props_for_component("punch-zoom", {"zoomTo": 9, "focusX": 2, "focusY": 0.5})
    assert zoom["zoomTo"] == 4
    assert zoom["focusX"] == 0.97


def test_normalize_truncates_long_text() -> None:
    from packages.video.effects_catalog import normalize_props_for_component

    long = "Puma Unisex-Adult Roma Basic Sneaker รองเท้าผ้าใบสวยมากจริงๆ"
    out = normalize_props_for_component("text-neon", {"text": long, "x": 0.5, "y": 0.5})
    assert len(out["text"]) <= 28

    badge = normalize_props_for_component("callout", {"label": long})
    assert len(badge["label"]) <= 24


def test_normalize_leaves_valid_values_untouched() -> None:
    from packages.video.effects_catalog import normalize_props_for_component

    out = normalize_props_for_component(
        "callout",
        {"label": "ลด 50%", "x": 0.5, "y": 0.2, "fontSize": 64, "position": "top-right"},
    )
    assert out == {"label": "ลด 50%", "x": 0.5, "y": 0.2, "fontSize": 64, "position": "top-right"}


# ── missing_required_content_key (props: {} safety net, observed live) ──────


def test_missing_required_content_key_flags_empty_props() -> None:
    # Regression: the model picked "text-neon" at the right moment but shipped
    # props: {} — that must not slip through and render a bland default.
    assert missing_required_content_key("text-neon", {}) == "text"
    assert missing_required_content_key("text-neon", {"text": "  "}) == "text"
    assert missing_required_content_key("text-neon", {"text": "ลดราคา"}) is None


def test_missing_required_content_key_checks_primary_key_only() -> None:
    # marker-highlight's "highlight" is the one prop that can't be empty;
    # before/after are legitimately optional lead-in/trail-off text.
    assert missing_required_content_key("marker-highlight", {"highlight": "ลดจริง"}) is None
    assert missing_required_content_key("marker-highlight", {}) == "highlight"


def test_missing_required_content_key_ignores_components_without_text() -> None:
    # vibe-wash/shape-kit/particle-burst have no primary text prop to police.
    assert missing_required_content_key("vibe-wash", {}) is None
    assert missing_required_content_key("shape-kit", {}) is None


def test_zoom_ramp_defaults_to_hard_cut() -> None:
    assert _zoom_ramp_sec("cut", 0.3) == 0.05
    assert _zoom_ramp_sec(None, 0.3) == 0.05
    assert _zoom_ramp_sec("typo", 0.3) == 0.05
    assert _zoom_ramp_sec("push", 0.3) == 0.3
    assert _zoom_ramp_sec("push", 1.0) == 0.4
