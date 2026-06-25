"""Pillow-based popup overlay renderer for TikTok video editing."""

from __future__ import annotations

import pathlib
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

# (width, height) in pixels for each popup template
POPUP_SIZES: dict[str, tuple[int, int]] = {
    "price": (500, 130),
    "cta": (460, 100),
    "product_name": (760, 75),
    "arrow": (90, 100),
}

POPUP_TEMPLATES = tuple(POPUP_SIZES.keys())

# Position names → (anchor relative to bottom-center by default)
_POSITIONS = {"bottom-center", "bottom-left", "bottom-right", "top-center", "center"}


def popup_size(template: str) -> tuple[int, int]:
    """Return (width, height) for template."""
    if template not in POPUP_SIZES:
        raise ValueError(f"Unknown popup template: {template!r}. Valid: {list(POPUP_SIZES)}")
    return POPUP_SIZES[template]


def popup_position_xy(
    position: str,
    vid_w: int,
    vid_h: int,
    popup_w: int,
    popup_h: int,
    margin: int = 80,
) -> tuple[int, int]:
    """Return (x, y) top-left pixel coordinate for popup overlay in the video frame."""
    cx = (vid_w - popup_w) // 2
    if position == "bottom-center":
        return cx, vid_h - popup_h - margin
    if position == "bottom-left":
        return margin, vid_h - popup_h - margin
    if position == "bottom-right":
        return vid_w - popup_w - margin, vid_h - popup_h - margin
    if position == "top-center":
        return cx, margin
    if position == "center":
        return cx, (vid_h - popup_h) // 2
    return cx, vid_h - popup_h - margin  # fallback → bottom-center


def render_popup_png(
    template: str,
    data: dict[str, Any],
    output_path: pathlib.Path,
    canvas_w: int = 1080,
    canvas_h: int = 1920,
) -> None:
    """Render a transparent-background popup PNG using Pillow.

    The image size is POPUP_SIZES[template], not the full canvas.
    Use popup_position_xy() to compute the overlay x,y in the video frame.
    """
    from PIL import Image, ImageDraw

    pw, ph = popup_size(template)
    img = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if template == "price":
        _draw_price(draw, img, data, pw, ph)
    elif template == "cta":
        _draw_cta(draw, img, data, pw, ph)
    elif template == "product_name":
        _draw_product_name(draw, img, data, pw, ph)
    elif template == "arrow":
        _draw_arrow(draw, img, data, pw, ph)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    log.debug("popup_rendered", template=template, path=str(output_path))


# ── internal drawing helpers ──────────────────────────────────────────────────


def _load_font(size: int):
    """Load a system font that supports Thai. Falls back to Pillow default."""
    from PIL import ImageFont

    candidates = [
        "C:/Windows/Fonts/tahoma.ttf",
        "C:/Windows/Fonts/tahomabd.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/calibri.ttf",
    ]
    for path in candidates:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _rounded_rect(
    draw: Any,
    x: int, y: int, w: int, h: int,
    radius: int,
    fill: tuple,
) -> None:
    """Draw a filled rounded rectangle."""
    r = min(radius, w // 2, h // 2)
    draw.rectangle([x + r, y, x + w - r, y + h], fill=fill)
    draw.rectangle([x, y + r, x + w, y + h - r], fill=fill)
    draw.ellipse([x, y, x + 2 * r, y + 2 * r], fill=fill)
    draw.ellipse([x + w - 2 * r, y, x + w, y + 2 * r], fill=fill)
    draw.ellipse([x, y + h - 2 * r, x + 2 * r, y + h], fill=fill)
    draw.ellipse([x + w - 2 * r, y + h - 2 * r, x + w, y + h], fill=fill)


def _centered_text(draw: Any, img_w: int, img_h: int, text: str, font: Any, fill: tuple) -> None:
    """Draw text centered in the image."""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (img_w - tw) // 2
    y = (img_h - th) // 2
    draw.text((x, y), text, fill=fill, font=font)


def _draw_price(draw: Any, img: Any, data: dict, pw: int, ph: int) -> None:
    price = str(data.get("price", "0"))
    unit = data.get("unit", "บาท")

    # Amber badge background
    _rounded_rect(draw, 0, 0, pw, ph, 22, (255, 195, 0, 230))

    # Price number (large)
    price_font = _load_font(68)
    unit_font = _load_font(34)

    pb = draw.textbbox((0, 0), price, font=price_font)
    ub = draw.textbbox((0, 0), unit, font=unit_font)
    price_w = pb[2] - pb[0]
    price_h = pb[3] - pb[1]
    unit_w = ub[2] - ub[0]
    unit_h = ub[3] - ub[1]

    gap = 8
    total_w = price_w + gap + unit_w
    sx = (pw - total_w) // 2

    price_y = (ph - price_h) // 2
    unit_y = price_y + price_h - unit_h  # baseline-align unit to price

    draw.text((sx, price_y), price, fill=(30, 20, 0, 255), font=price_font)
    draw.text((sx + price_w + gap, unit_y), unit, fill=(60, 40, 0, 255), font=unit_font)


def _draw_cta(draw: Any, img: Any, data: dict, pw: int, ph: int) -> None:
    text = str(data.get("text", "ซื้อเลย!"))

    # Pill background (bright amber)
    _rounded_rect(draw, 0, 0, pw, ph, ph // 2, (255, 145, 0, 235))

    font = _load_font(40)
    _centered_text(draw, pw, ph, text, font, (255, 255, 255, 255))


def _draw_product_name(draw: Any, img: Any, data: dict, pw: int, ph: int) -> None:
    text = str(data.get("name", data.get("text", "สินค้า")))

    font = _load_font(44)
    bb = draw.textbbox((0, 0), text, font=font)
    tw = bb[2] - bb[0]
    th = bb[3] - bb[1]

    # Semi-transparent black background strip
    _rounded_rect(draw, 0, 0, pw, ph, 10, (0, 0, 0, 160))

    tx = (pw - tw) // 2
    ty = (ph - th) // 2

    # Slight shadow
    draw.text((tx + 2, ty + 2), text, fill=(0, 0, 0, 180), font=font)
    draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)

    # Underline bar
    bar_y = ty + th + 4
    bar_x = tx
    draw.rectangle([bar_x, bar_y, bar_x + tw, bar_y + 4], fill=(255, 195, 0, 200))


def _draw_arrow(draw: Any, img: Any, data: dict, pw: int, ph: int) -> None:
    color = data.get("color", (255, 195, 0, 230))
    if isinstance(color, (list, tuple)) and len(color) == 3:
        color = (*color, 230)

    # Downward-pointing triangle (arrow)
    margin = 10
    points = [
        (margin, margin),
        (pw - margin, margin),
        (pw // 2, ph - margin),
    ]
    draw.polygon(points, fill=tuple(color))
