"""Regenerate packages/blog/brand.json (the `brand` block of the blog MCP tool
`get_site_info`) from noey-frontend's own design tokens.

The colours are EXTRACTED from noey-frontend/src/app/globals.css (the palette
block, light and dark) instead of being retyped, and the logo mark is copied
from noey-frontend/src/app/icon.svg into packages/blog/render_assets/brand/ —
the backend image does not contain noey-frontend, so both are committed and
tests/test_blog_render.py re-runs this with --check: the moment the site's
palette or mark changes, the test fails until this is re-run.

Run from backend/:
    python scripts/build_brand_info.py          # write
    python scripts/build_brand_info.py --check  # exit 1 when out of date
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
SITE_APP = BACKEND.parent / "noey-frontend" / "src" / "app"
CSS = SITE_APP / "globals.css"
ICON = SITE_APP / "icon.svg"
TARGET = BACKEND / "packages" / "blog" / "brand.json"
MARK = BACKEND / "packages" / "blog" / "render_assets" / "brand" / "noey-mark.svg"

#: The tokens a writer needs for graphics, with what each one is for. Names
#: are the site's CSS custom properties without `--color-`.
ROLES = {
    "bg": "page background",
    "surface": "card / panel background",
    "text": "body text",
    "accent": "primary brand colour (buttons, highlights, the mark)",
    "accent-2": "secondary brand colour",
    "accent-100": "pale accent tint (chip background)",
    "accent-200": "light accent tint",
    "accent-300": "soft accent",
    "accent-700": "deep accent (text on pale tints)",
    "accent-800": "darkest accent",
    "neutral-300": "light rule / border",
    "neutral-600": "muted text",
    "neutral-800": "strong neutral",
    "success": "positive / done",
    "danger": "warning / not supported",
}

_HEX = re.compile(r"^#[0-9a-fA-F]{3,8}$")


def _block(css: str, selector_start: str) -> dict[str, str]:
    """`--color-*: #hex;` declarations of the first rule whose selector starts so."""
    i = css.index(selector_start)
    body = css[css.index("{", i) + 1 : css.index("}", i)]
    out: dict[str, str] = {}
    for name, value in re.findall(r"--color-([a-z0-9-]+)\s*:\s*([^;]+);", body):
        value = value.strip()
        if _HEX.match(value):
            out[name] = value.lower()
    return out


def extract() -> dict:
    css = CSS.read_text(encoding="utf-8")
    night = _block(css, ":root {")["night"]
    light = _block(css, ":root,\n.theme-day")
    dark = {**light, **_block(css, 'html[data-theme="dark"],\n.theme-night'), "bg": night}
    pick = lambda pal: {k: pal[k] for k in ROLES if k in pal}  # noqa: E731
    return {
        "source": "noey-frontend/src/app/globals.css (palette) + src/app/icon.svg (mark)",
        "roles": ROLES,
        "colors": {"light": pick(light), "dark": pick(dark)},
        "primary": light["accent"],
        "secondary": light["accent-2"],
        "primary_on_dark": dark["accent"],
        "night": night,
    }


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    fresh = render(extract())
    mark = ICON.read_text(encoding="utf-8")
    if "--check" in sys.argv:
        stale = []
        if (TARGET.read_text(encoding="utf-8") if TARGET.exists() else "") != fresh:
            stale.append("brand.json")
        if (MARK.read_text(encoding="utf-8") if MARK.exists() else "") != mark:
            stale.append("render_assets/brand/noey-mark.svg")
        if stale:
            print(f"{', '.join(stale)} out of date — run: python scripts/build_brand_info.py", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(fresh, encoding="utf-8")
    MARK.parent.mkdir(parents=True, exist_ok=True)
    MARK.write_text(mark, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(BACKEND)} and {MARK.relative_to(BACKEND)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
