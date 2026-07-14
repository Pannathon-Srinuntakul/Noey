"""Bundled caption fonts for burned-in subtitles.

Font files live in backend/data/fonts/*.ttf (Thai-capable, OFL-licensed,
sourced from Google Fonts — see data/fonts/OFL_LICENSES.txt).
"""

from __future__ import annotations

import pathlib

from packages.video.storage import data_root

FONT_CATALOG = {
    "kanit": {"label": "Kanit", "fontname": "Kanit", "file": "Kanit-Bold.ttf"},
    "prompt": {"label": "Prompt", "fontname": "Prompt", "file": "Prompt-Bold.ttf"},
    "sarabun": {"label": "Sarabun", "fontname": "Sarabun", "file": "Sarabun-Bold.ttf"},
    "anuphan": {"label": "Anuphan", "fontname": "Anuphan", "file": "Anuphan-Variable.ttf"},
}


def fonts_dir() -> pathlib.Path:
    return data_root() / "fonts"


def font_face(key: str) -> str:
    """ASS Style fontname for a catalog key. Raises ValueError if unknown."""
    if key not in FONT_CATALOG:
        raise ValueError(f"Unknown caption font '{key}'. Available: {list(FONT_CATALOG)}")
    return FONT_CATALOG[key]["fontname"]


def escape_ass_filter_path(p: pathlib.Path) -> str:
    """Escape a path for use as an ffmpeg ass/subtitles filter option value.

    Needs BOTH backslash-escaping the drive-letter colon AND single-quote
    wrapping — quoting alone doesn't stop ffmpeg's filtergraph parser from
    still splitting on an unescaped ':', and escaping alone doesn't protect
    a path containing a space (both are true for a repo path with spaces
    in a directory name, e.g. on a Windows drive).
    """
    return "'" + p.as_posix().replace(":", r"\:") + "'"
