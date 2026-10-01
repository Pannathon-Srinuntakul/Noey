"""The brand kit a writer draws with: bundled fonts, Lucide icons and the mark.

Files (all under render_assets/, committed; licences next to them):

- fonts/NotoSansThai-{400,500,600,700}.ttf — static instances of Noto Sans
  Thai (OFL; instanced from the Google Fonts variable font with fontTools —
  the cover renderer cannot read a variable font). The site's own font.
- fonts/IBMPlexSansThai-{Regular,Medium,SemiBold,Bold}.ttf — IBM Plex Sans
  Thai (OFL), static. Carries Latin too.
- fonts/web/*.woff2 — the same faces for browsers (Noto as the variable font),
  served by the embed origin at /fonts/<file> for visuals.
- icons/lucide.json — lucide-static 1.49.0 (ISC): name → the icon's inner SVG.
- brand/noey-mark.svg — the site's icon.svg (scripts/build_brand_info.py).

Pure: no settings except where a URL needs the embed origin (passed in).
"""

from __future__ import annotations

import json
import pathlib
from functools import lru_cache

ASSETS = pathlib.Path(__file__).with_name("render_assets")
FONTS_DIR = ASSETS / "fonts"
WEB_FONTS_DIR = FONTS_DIR / "web"
ICONS_JSON = ASSETS / "icons" / "lucide.json"
MARK_SVG = ASSETS / "brand" / "noey-mark.svg"

DEFAULT_FONT = "Noto Sans Thai"
FONT_STACK = "'Noto Sans Thai', 'IBM Plex Sans Thai', sans-serif"

#: Browser faces (visuals): family → [(woff2 file, weight range)].
WEB_FONTS: dict[str, list[tuple[str, str]]] = {
    "Noto Sans Thai": [("NotoSansThai-Variable.woff2", "100 900")],
    "IBM Plex Sans Thai": [
        ("IBMPlexSansThai-Regular.woff2", "400"),
        ("IBMPlexSansThai-Medium.woff2", "500"),
        ("IBMPlexSansThai-SemiBold.woff2", "600"),
        ("IBMPlexSansThai-Bold.woff2", "700"),
    ],
}
#: Cover faces (static TTF): family → [(file, weight)].
COVER_FONTS: dict[str, list[tuple[str, int]]] = {
    "Noto Sans Thai": [
        ("NotoSansThai-400.ttf", 400),
        ("NotoSansThai-500.ttf", 500),
        ("NotoSansThai-600.ttf", 600),
        ("NotoSansThai-700.ttf", 700),
    ],
    "IBM Plex Sans Thai": [
        ("IBMPlexSansThai-Regular.ttf", 400),
        ("IBMPlexSansThai-Medium.ttf", 500),
        ("IBMPlexSansThai-SemiBold.ttf", 600),
        ("IBMPlexSansThai-Bold.ttf", 700),
    ],
}
WEB_FONT_FILES = frozenset(f for faces in WEB_FONTS.values() for f, _ in faces)


def web_font_bytes(file: str) -> bytes | None:
    if file not in WEB_FONT_FILES:
        return None
    return (WEB_FONTS_DIR / file).read_bytes()


def font_face_css(font_origin: str) -> str:
    """@font-face rules for every browser face, served by `font_origin`."""
    base = font_origin.rstrip("/")
    return "".join(
        f"@font-face{{font-family:'{family}';src:url('{base}/fonts/{file}') format('woff2');"
        f"font-weight:{weight};font-style:normal;font-display:block}}"
        for family, faces in WEB_FONTS.items()
        for file, weight in faces
    )


def fonts_info(font_origin: str) -> list[dict[str, object]]:
    """What get_site_info tells a writer about fonts."""
    base = font_origin.rstrip("/")
    return [
        {
            "family": "Noto Sans Thai",
            "weights": [400, 500, 600, 700] ,
            "visual_weights": "100–900 (variable)",
            "role": "the site's own font — use it by default (headings 600–700, body 400)",
            "urls": [f"{base}/fonts/{f}" for f, _ in WEB_FONTS["Noto Sans Thai"]],
        },
        {
            "family": "IBM Plex Sans Thai",
            "weights": [400, 500, 600, 700],
            "role": "a second, more technical face (numbers, labels)",
            "urls": [f"{base}/fonts/{f}" for f, _ in WEB_FONTS["IBM Plex Sans Thai"]],
        },
    ]


@lru_cache(maxsize=1)
def _icon_data() -> dict[str, object]:
    data: dict[str, object] = json.loads(ICONS_JSON.read_text(encoding="utf-8"))
    return data


def _icons() -> dict[str, str]:
    icons = _icon_data()["icons"]
    assert isinstance(icons, dict)
    return icons


def icon_set() -> str:
    return f"Lucide {_icon_data()['version']} (ISC)"


def icon_svg(name: str, *, size: int = 24, color: str = "currentColor", stroke: float = 2) -> str | None:
    """A Lucide icon as an inline <svg> element to paste into html, or None."""
    inner = _icons().get(name)
    if inner is None:
        return None
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
        f'stroke="{color}" stroke-width="{stroke:g}" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>'
    )


def icon_search(query: str, limit: int = 30) -> list[str]:
    q = query.strip().lower()
    names = sorted(_icons())
    return [n for n in names if q in n][:limit]


def mark_svg() -> str:
    return MARK_SVG.read_text(encoding="utf-8")
