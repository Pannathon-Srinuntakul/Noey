"""Render output artifacts shared by the worker and the sidecar.

Extracted verbatim from ``services/worker/tasks.py`` render_video: SRT writing
and the CapCut bundle (manifest.json + README.txt + capcut_bundle.zip).
Pure filesystem — no DB/arq.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any


def write_srt(captions: list[dict], path: Path) -> None:
    """Write captions list to SRT file."""

    def _ts(secs: float) -> str:
        h = int(secs // 3600)
        m = int((secs % 3600) // 60)
        s = int(secs % 60)
        ms = int((secs - int(secs)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines: list[str] = []
    for i, cap in enumerate(captions, 1):
        lines += [str(i), f"{_ts(cap['start'])} --> {_ts(cap['end'])}", cap["text"], ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def build_capcut_manifest(
    project_uid: str,
    timeline: dict[str, Any],
    cuts: list[dict[str, Any]],
    clip_paths: list[Path],
    *,
    ass_burned: bool = False,
    graphics: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    graphics = graphics or []
    return {
        "project_uid": project_uid,
        "mode": timeline.get("mode", "talking_head"),
        "output": timeline.get("output", {}),
        "clips": [{"file": f"clips/{p.name}", "label": cuts[i].get("label", "")} for i, p in enumerate(clip_paths)],
        "captions": "captions/subtitles.srt",
        "captions_ass": "captions/subtitles.ass" if ass_burned else None,
        "graphics": [
            {"name": g["name"], "at": g["at"], "x": g.get("x", 0), "y": g.get("y", 0)}
            for g in graphics
        ],
    }


CAPCUT_README = (
    "CapCut Import Guide\n"
    "===================\n"
    "1. Import clips/ folder as separate video tracks\n"
    "2. Import captions/subtitles.srt as captions\n"
    "3. Refer to manifest.json for layer ordering\n"
    "4. final.mp4 is the pre-rendered output (optional reference)\n"
)


def build_capcut_bundle(
    output_dir: Path,
    *,
    project_uid: str,
    timeline: dict[str, Any],
    cuts: list[dict[str, Any]],
    clip_paths: list[Path],
    final_path: Path,
    srt_path: Path,
    ass_burned: bool = False,
    graphics: list[dict[str, Any]] | None = None,
) -> Path:
    """Write manifest.json + README.txt and zip everything → capcut_bundle.zip."""
    graphics = graphics or []
    manifest = build_capcut_manifest(
        project_uid, timeline, cuts, clip_paths, ass_burned=ass_burned, graphics=graphics
    )
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    readme_path = output_dir / "README.txt"
    readme_path.write_text(CAPCUT_README, encoding="utf-8")

    zip_path = output_dir / "capcut_bundle.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(final_path, "final.mp4")
        for cp in clip_paths:
            zf.write(cp, f"clips/{cp.name}")
        zf.write(srt_path, f"captions/{srt_path.name}")
        ass_zip = srt_path.parent / "subtitles.ass"
        if ass_zip.exists():
            zf.write(ass_zip, "captions/subtitles.ass")
        zf.write(manifest_path, "manifest.json")
        zf.write(readme_path, "README.txt")
        if graphics:
            try:
                from packages.video.stickers import sticker_path as _sp
                seen: set[str] = set()
                for g in graphics:
                    name = g["name"]
                    if name not in seen:
                        zf.write(_sp(name), f"stickers/{name}.png")
                        seen.add(name)
            except Exception:
                pass
    return zip_path
