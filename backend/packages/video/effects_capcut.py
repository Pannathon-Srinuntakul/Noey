"""CapCut export for the effects layer (REMOTION_EFFECTS_REQUIREMENTS.md §8/§9).

Extends the existing bundle idea (render_common.build_capcut_bundle) to animated
effects. Each OVERLAY effect instance is exported as its own transparent clip
plus a timing/position entry in manifest.json, alongside the ready-to-use
composited final_fx.mp4. TRANSFORM effects (punch-zoom) are baked into the
footage and cannot be a separate asset — they are listed in the manifest as a
note so the editor knows they are already applied.

Format decision (the §9 spike): the transparent overlays ship as the ProRes 4444
.mov files the Node/Remotion sidecar already produced — their alpha is verified
and CapCut desktop imports ProRes-with-alpha directly. A VP9/alpha-webm
reconversion was tried and dropped the alpha channel (ffmpeg emitted yuv420p),
so re-encoding would be both lossy and unreliable; shipping the .mov as-is is the
safe choice. (CapCut *import* itself is not automatable here, so that step is
verified manually.)
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path
from typing import Any

from packages.video.effects import EffectsDoc

CAPCUT_README = (
    "Effects export\n"
    "==============\n"
    "- final_fx.mp4: the finished video with all effects already applied (ready to use).\n"
    "- overlays/<id>.mov: each overlay effect as a transparent clip (ProRes 4444, has alpha).\n"
    "  Import these onto layers above your base clip in CapCut, positioned per manifest.json.\n"
    "- manifest.json: per-effect id, component, kind, start/duration, and (overlays) file.\n"
    "- Transform effects (e.g. punch-zoom) are baked into final_fx.mp4 and listed in\n"
    "  manifest.json for reference (they are not separate assets).\n"
)


def build_effects_manifest(doc: EffectsDoc, overlay_files: dict[str, str]) -> dict[str, Any]:
    """Manifest describing every effect instance for CapCut re-assembly."""
    entries: list[dict[str, Any]] = []
    for inst in doc.instances:
        entry: dict[str, Any] = {
            "id": inst.id,
            "componentId": inst.componentId,
            "kind": inst.kind,
            "startSec": round(inst.startSec, 3),
            "durationSec": round(inst.durationSec, 3),
            "props": inst.props,
        }
        if inst.kind == "overlay":
            entry["file"] = overlay_files.get(inst.id)
            entry["note"] = "transparent overlay — place on a layer above the base clip"
        else:
            entry["note"] = "baked into final_fx.mp4 (transform on the footage)"
        entries.append(entry)
    return {"version": doc.version, "effects": entries}


def build_effects_capcut_bundle(
    out_zip: str | Path,
    *,
    final_fx: str | Path,
    doc: EffectsDoc,
    overlay_paths: dict[str, str | Path],
) -> Path:
    """Write a CapCut import bundle for an effects render.

    ``overlay_paths`` maps overlay instance id → its transparent .mov. Returns the
    zip path. Overlay clips missing from disk are skipped (listed with no file).
    """
    out_zip = Path(out_zip)
    overlay_files: dict[str, str] = {}
    staged: dict[str, Path] = {}
    for inst in doc.overlays():
        src = overlay_paths.get(inst.id)
        if src and Path(src).is_file():
            name = f"overlays/{inst.id}.mov"
            overlay_files[inst.id] = name
            staged[name] = Path(src)

    manifest = build_effects_manifest(doc, overlay_files)

    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        if Path(final_fx).is_file():
            zf.write(final_fx, "final_fx.mp4")
        for arcname, path in staged.items():
            zf.write(path, arcname)
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("README.txt", CAPCUT_README)
    return out_zip


def copy_overlays_for_bundle(overlay_paths: dict[str, str | Path], dest_dir: str | Path) -> None:
    """Copy overlay .movs into a flat dir (used when exporting outside a zip)."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    for inst_id, src in overlay_paths.items():
        if Path(src).is_file():
            shutil.copy2(src, dest / f"{inst_id}.mov")
