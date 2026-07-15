"""Tests for the effects CapCut export bundle."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from packages.video.effects import EffectInstance, EffectsDoc
from packages.video.effects_capcut import build_effects_capcut_bundle, build_effects_manifest


def _doc() -> EffectsDoc:
    return EffectsDoc(
        instances=[
            EffectInstance(id="ov1", kind="overlay", componentId="sticker-badge", startSec=1.0, durationSec=3.0),
            EffectInstance(id="tz1", kind="transform", componentId="punch-zoom", startSec=0.5, durationSec=2.0),
        ]
    )


def test_manifest_marks_overlay_file_and_transform_note() -> None:
    m = build_effects_manifest(_doc(), {"ov1": "overlays/ov1.mov"})
    by_id = {e["id"]: e for e in m["effects"]}
    assert by_id["ov1"]["file"] == "overlays/ov1.mov"
    assert "baked" in by_id["tz1"]["note"]
    assert "file" not in by_id["tz1"]


def test_bundle_contains_final_manifest_and_overlays(tmp_path: Path) -> None:
    # fake assets
    final_fx = tmp_path / "final_fx.mp4"
    final_fx.write_bytes(b"video")
    ov = tmp_path / "ov1.mov"
    ov.write_bytes(b"overlay")

    out = build_effects_capcut_bundle(
        tmp_path / "bundle.zip",
        final_fx=final_fx,
        doc=_doc(),
        overlay_paths={"ov1": ov},
    )
    with zipfile.ZipFile(out) as zf:
        names = set(zf.namelist())
        assert {"final_fx.mp4", "overlays/ov1.mov", "manifest.json", "README.txt"} <= names
        manifest = json.loads(zf.read("manifest.json"))
    ids = {e["id"] for e in manifest["effects"]}
    assert ids == {"ov1", "tz1"}


def test_bundle_skips_missing_overlay(tmp_path: Path) -> None:
    final_fx = tmp_path / "final_fx.mp4"
    final_fx.write_bytes(b"v")
    out = build_effects_capcut_bundle(
        tmp_path / "b.zip",
        final_fx=final_fx,
        doc=_doc(),
        overlay_paths={},  # no overlay files on disk
    )
    with zipfile.ZipFile(out) as zf:
        assert not any(n.startswith("overlays/") for n in zf.namelist())
        manifest = json.loads(zf.read("manifest.json"))
    ov = next(e for e in manifest["effects"] if e["id"] == "ov1")
    assert ov["file"] is None
