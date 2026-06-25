"""Generate static sticker PNGs for video overlay (Tier 3d).

Run once from backend/:
    python scripts/generate_stickers.py

Writes to backend/data/stickers/*.png — RGBA, transparent background.
"""

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = pathlib.Path(__file__).parent.parent / "data" / "stickers"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def _try_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("C:/Windows/Fonts/Tahoma.ttf", "C:/Windows/Fonts/Arial.ttf", "C:/Windows/Fonts/Calibri.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def gen_arrow_right(path: pathlib.Path) -> None:
    """Chunky right-pointing arrow, white fill with black border."""
    w, h = 200, 120
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [
        (10, 40), (130, 40), (130, 10),
        (190, 60), (130, 110), (130, 80), (10, 80),
    ]
    d.polygon(pts, fill=(255, 255, 255, 230), outline=(0, 0, 0, 220), width=3)
    img.save(path)


def gen_arrow_up(path: pathlib.Path) -> None:
    """Chunky up-pointing arrow."""
    w, h = 120, 200
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [
        (60, 10), (110, 80), (80, 80),
        (80, 190), (40, 190), (40, 80), (10, 80),
    ]
    d.polygon(pts, fill=(255, 255, 255, 230), outline=(0, 0, 0, 220), width=3)
    img.save(path)


def gen_fire(path: pathlib.Path) -> None:
    """Simple flame shape in orange/red gradient."""
    w, h = 120, 160
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Outer flame (red)
    pts_outer = [
        (60, 5), (95, 50), (110, 80),
        (100, 140), (60, 155), (20, 140),
        (10, 80), (25, 50),
    ]
    d.polygon(pts_outer, fill=(220, 50, 20, 240))
    # Inner flame (orange)
    pts_inner = [
        (60, 30), (82, 65), (90, 90),
        (80, 130), (60, 140), (40, 130),
        (30, 90), (38, 65),
    ]
    d.polygon(pts_inner, fill=(255, 165, 0, 240))
    # Core (yellow)
    pts_core = [
        (60, 70), (72, 90), (70, 115),
        (60, 125), (50, 115), (48, 90),
    ]
    d.polygon(pts_core, fill=(255, 240, 0, 240))
    img.save(path)


def gen_star(path: pathlib.Path) -> None:
    """5-pointed star, gold fill."""
    w, h = 140, 140
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, r_out, r_in = 70, 70, 65, 28
    pts = []
    for i in range(10):
        angle = math.radians(-90 + i * 36)
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    d.polygon(pts, fill=(255, 210, 0, 240), outline=(180, 130, 0, 240), width=2)
    img.save(path)


def gen_heart(path: pathlib.Path) -> None:
    """Heart shape, red fill."""
    w, h = 130, 120
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Two circles + triangle
    d.ellipse((5, 10, 70, 70), fill=(220, 30, 60, 240))
    d.ellipse((60, 10, 125, 70), fill=(220, 30, 60, 240))
    d.polygon([(5, 45), (125, 45), (65, 115)], fill=(220, 30, 60, 240))
    img.save(path)


def gen_checkmark(path: pathlib.Path) -> None:
    """Bold green checkmark."""
    w, h = 120, 120
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [
        (10, 55), (40, 90), (110, 20),
        (110, 40), (40, 110), (10, 75),
    ]
    d.polygon(pts, fill=(30, 180, 60, 240), outline=(15, 120, 40, 240), width=2)
    img.save(path)


def gen_burst(path: pathlib.Path) -> None:
    """Starburst / sale badge shape, red."""
    w, h = 160, 160
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, r_out, r_in, n = 80, 80, 75, 55, 12
    pts = []
    for i in range(n * 2):
        angle = math.radians(-90 + i * (360 / (n * 2)))
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    d.polygon(pts, fill=(210, 30, 40, 240), outline=(150, 10, 20, 240), width=2)

    font = _try_font(28)
    d.text((cx, cy), "SALE", font=font, fill=(255, 255, 255, 255), anchor="mm")
    img.save(path)


def gen_label(text: str, path: pathlib.Path, bg=(255, 80, 0, 230)) -> None:
    """Simple rounded pill label with text."""
    font = _try_font(32)
    tmp = Image.new("RGBA", (1, 1))
    td = ImageDraw.Draw(tmp)
    bbox = td.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad_x, pad_y = 24, 16
    w, h = tw + pad_x * 2, th + pad_y * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = h // 2
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=bg)
    d.text((pad_x, pad_y), text, font=font, fill=(255, 255, 255, 255))
    img.save(path)


STICKERS = [
    ("arrow_right", gen_arrow_right),
    ("arrow_up", gen_arrow_up),
    ("fire", gen_fire),
    ("star", gen_star),
    ("heart", gen_heart),
    ("checkmark", gen_checkmark),
    ("burst", gen_burst),
]

LABELS = [
    ("label_new", "NEW!", (30, 160, 80, 230)),
    ("label_hot", "HOT", (210, 30, 40, 230)),
    ("label_sale", "SALE", (210, 80, 0, 230)),
    ("label_link", "LINK IN BIO", (40, 80, 200, 230)),
]

if __name__ == "__main__":
    for name, fn in STICKERS:
        p = OUT_DIR / f"{name}.png"
        fn(p)
        print(f"  {p.name} ({p.stat().st_size} bytes)")

    for name, text, bg in LABELS:
        p = OUT_DIR / f"{name}.png"
        gen_label(text, p, bg)
        print(f"  {p.name} ({p.stat().st_size} bytes)")

    print(f"\nStickers written to {OUT_DIR}")
