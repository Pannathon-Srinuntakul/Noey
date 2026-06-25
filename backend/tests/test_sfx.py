"""Unit tests for SFX catalog and placement rules (no DB, no ffmpeg, no filesystem)."""

import pytest

from packages.video.assets import SFX_CATALOG, sfx_suggestions_for_cuts


def _cut(source: str, in_: float, out: float, label: str = "speech") -> dict:
    return {"type": "cut", "source": source, "in": in_, "out": out, "label": label}


# ── sfx_path ─────────────────────────────────────────────────────────────────


def test_sfx_path_raises_on_unknown() -> None:
    from packages.video.assets import sfx_path

    with pytest.raises(ValueError, match="Unknown SFX"):
        sfx_path("nonexistent_sound")


def test_sfx_path_known_names_in_catalog() -> None:
    """All catalog entries must be reachable via sfx_path without error."""
    from unittest.mock import patch
    import pathlib
    from packages.video.assets import sfx_path

    fake_root = pathlib.Path("/fake/data")
    with patch("packages.video.assets.data_root", return_value=fake_root):
        for name in SFX_CATALOG:
            p = sfx_path(name)
            assert p.parent == fake_root / "sfx"
            assert p.name == SFX_CATALOG[name]["file"]


# ── sfx_suggestions_for_cuts ─────────────────────────────────────────────────


def test_empty_cuts_returns_empty() -> None:
    assert sfx_suggestions_for_cuts([], 0.0) == []


def test_single_cut_yields_ding() -> None:
    cuts = [_cut("clip0", 1.0, 6.0, "opening")]
    result = sfx_suggestions_for_cuts(cuts, 5.0)
    assert len(result) == 1
    assert result[0]["name"] == "ding"
    assert result[0]["at"] == 0.0
    assert 0.0 < result[0]["volume"] <= 1.0


def test_two_cuts_ding_and_pop() -> None:
    cuts = [
        _cut("clip0", 0.0, 4.0, "opening"),
        _cut("clip0", 10.0, 14.0, "conclusion"),
    ]
    result = sfx_suggestions_for_cuts(cuts, 8.0)
    assert len(result) == 2
    assert result[0]["name"] == "ding"
    assert result[0]["at"] == 0.0
    assert result[1]["name"] == "pop"
    assert result[1]["at"] == pytest.approx(4.0)


def test_multi_cut_positions_and_alternating() -> None:
    cuts = [
        _cut("clip0", 1.0, 5.0, "opening"),     # 4 s → output 0.0–4.0
        _cut("clip0", 10.0, 14.0, "speech"),    # 4 s → output 4.0–8.0
        _cut("clip0", 20.0, 23.0, "speech"),    # 3 s → output 8.0–11.0
        _cut("clip0", 30.0, 33.0, "conclusion"),# 3 s → output 11.0–14.0
    ]
    result = sfx_suggestions_for_cuts(cuts, 14.0)

    assert result[0]["name"] == "ding"
    assert result[0]["at"] == pytest.approx(0.0)

    assert result[1]["name"] == "whoosh"         # first internal (index 0 → whoosh)
    assert result[1]["at"] == pytest.approx(4.0)

    assert result[2]["name"] == "pop"            # second internal (index 1 → pop)
    assert result[2]["at"] == pytest.approx(8.0)

    assert result[-1]["name"] == "pop"           # conclusion always pop
    assert result[-1]["at"] == pytest.approx(11.0)


def test_all_volumes_in_range() -> None:
    cuts = [
        _cut("clip0", 0.0, 3.0, "opening"),
        _cut("clip0", 5.0, 8.0, "speech"),
        _cut("clip0", 10.0, 13.0, "conclusion"),
    ]
    for entry in sfx_suggestions_for_cuts(cuts, 9.0):
        assert 0.0 < entry["volume"] <= 1.0


def test_at_values_monotonically_increasing() -> None:
    cuts = [
        _cut("clip0", 0.0, 2.0, "opening"),
        _cut("clip0", 5.0, 7.0, "speech"),
        _cut("clip0", 10.0, 12.5, "speech"),
        _cut("clip0", 15.0, 17.0, "conclusion"),
    ]
    result = sfx_suggestions_for_cuts(cuts, 8.5)
    ats = [e["at"] for e in result]
    assert ats == sorted(ats)
