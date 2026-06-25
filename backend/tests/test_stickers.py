"""Unit tests for Tier 3d sticker helpers."""

import pytest

from packages.video.stickers import STICKER_CATALOG, default_graphics_for_timeline


def _cut(label: str = "speech", dur: float = 3.0) -> dict:
    return {"type": "cut", "source": "clip0", "in": 0.0, "out": dur, "label": label, "durationSec": dur}


def test_catalog_has_expected_names():
    assert "arrow_right" in STICKER_CATALOG
    assert "fire" in STICKER_CATALOG
    assert "star" in STICKER_CATALOG
    assert "label_new" in STICKER_CATALOG


def test_empty_cuts_no_graphics():
    assert default_graphics_for_timeline([]) == []


def test_opening_cut_gets_fire():
    cuts = [_cut("opening", 3.0), _cut("conclusion", 3.0)]
    graphics = default_graphics_for_timeline(cuts)
    names = [g["name"] for g in graphics]
    assert "fire" in names


def test_opening_at_time_zero_ish():
    cuts = [_cut("opening", 4.0), _cut("speech", 4.0)]
    graphics = default_graphics_for_timeline(cuts)
    fire_entries = [g for g in graphics if g["name"] == "fire"]
    assert fire_entries
    assert fire_entries[0]["at"] < 2.0


def test_conclusion_label_gets_label_new():
    cuts = [_cut("speech", 5.0), _cut("conclusion", 5.0)]
    graphics = default_graphics_for_timeline(cuts)
    names = [g["name"] for g in graphics]
    assert "label_new" in names


def test_product_mention_gets_arrow():
    cuts = [_cut("speech", 3.0), _cut("product_mention", 4.0), _cut("conclusion", 2.0)]
    graphics = default_graphics_for_timeline(cuts)
    names = [g["name"] for g in graphics]
    assert "arrow_up" in names or "label_link" in names


def test_all_graphics_have_required_fields():
    cuts = [_cut("opening"), _cut("product_mention"), _cut("conclusion")]
    graphics = default_graphics_for_timeline(cuts)
    for g in graphics:
        assert "name" in g
        assert "at" in g
        assert "x" in g
        assert "y" in g
        assert "duration" in g


def test_sticker_path_raises_unknown():
    from packages.video.stickers import sticker_path
    with pytest.raises((ValueError, FileNotFoundError)):
        sticker_path("nonexistent_sticker_xyz")
