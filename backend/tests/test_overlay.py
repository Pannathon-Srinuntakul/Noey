"""Unit tests for popup overlay renderer."""

import pathlib
import tempfile

import pytest

from packages.video.overlay import (
    POPUP_TEMPLATES,
    popup_position_xy,
    popup_size,
    render_popup_png,
)


def test_popup_size_valid():
    w, h = popup_size("price")
    assert w > 0 and h > 0


def test_popup_size_invalid():
    with pytest.raises(ValueError, match="Unknown popup template"):
        popup_size("nonexistent")


def test_popup_position_bottom_center():
    x, y = popup_position_xy("bottom-center", 1080, 1920, 500, 130)
    assert x == (1080 - 500) // 2
    assert y == 1920 - 130 - 80


def test_popup_position_top_center():
    x, y = popup_position_xy("top-center", 1080, 1920, 500, 130)
    assert x == (1080 - 500) // 2
    assert y == 80


def test_popup_position_bottom_right():
    x, y = popup_position_xy("bottom-right", 1080, 1920, 500, 130)
    assert x == 1080 - 500 - 80
    assert y == 1920 - 130 - 80


def test_popup_position_unknown_falls_back():
    x1, y1 = popup_position_xy("unknown_pos", 1080, 1920, 500, 130)
    x2, y2 = popup_position_xy("bottom-center", 1080, 1920, 500, 130)
    assert x1 == x2 and y1 == y2


@pytest.mark.parametrize("template", POPUP_TEMPLATES)
def test_render_popup_creates_file(template):
    data = {
        "price": "299",
        "text": "ซื้อเลย!",
        "name": "ครีม XYZ",
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        out = pathlib.Path(tmpdir) / f"{template}.png"
        render_popup_png(template, data, out)
        assert out.exists()
        assert out.stat().st_size > 0


def test_render_price_popup_is_png():
    """Price popup PNG is valid RGBA image."""
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmpdir:
        out = pathlib.Path(tmpdir) / "price.png"
        render_popup_png("price", {"price": "999"}, out)
        with Image.open(str(out)) as img:
            img.load()
            mode = img.mode
            size = img.size
        assert mode == "RGBA"
        w, h = popup_size("price")
        assert size == (w, h)


def test_render_arrow_popup_is_png():
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmpdir:
        out = pathlib.Path(tmpdir) / "arrow.png"
        render_popup_png("arrow", {}, out)
        with Image.open(str(out)) as img:
            img.load()
            mode = img.mode
        assert mode == "RGBA"


def test_all_templates_produce_correct_size():
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmpdir:
        results = {}
        for tpl in POPUP_TEMPLATES:
            out = pathlib.Path(tmpdir) / f"{tpl}.png"
            render_popup_png(tpl, {"price": "99", "text": "Buy", "name": "Item"}, out)
            with Image.open(str(out)) as img:
                img.load()
                results[tpl] = img.size
    for tpl, size in results.items():
        expected = popup_size(tpl)
        assert size == expected, f"{tpl}: size mismatch"
