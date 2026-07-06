"""Extract-frames command — sample Vision frames from normalized clips.

Reuses the exact frame extraction the server pipeline uses
(`extract_dub_budget_frames` + `extract_edge_frames`), then writes
``frames/frames_manifest.json`` whose entries match the backend
POST /videos/{uid}/analyze-frames manifest schema
({name, clip_id, time, scene_idx, scene_start, scene_end, edge?}).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.ffmpeg_bin import media_duration  # noqa: E402
from packages.video.scene import extract_dub_budget_frames, extract_edge_frames  # noqa: E402


class ExtractFramesJob(BaseModel):
    projectDir: Path


def run_extract_frames(job: ExtractFramesJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    sources_file = project_dir / "upload_sources.json"
    if not sources_file.is_file():
        raise FileNotFoundError("upload_sources.json missing — run ingest first")
    sources = json.loads(sources_file.read_text(encoding="utf-8"))

    frames_dir = project_dir / "frames"
    all_frames: list[dict[str, Any]] = []
    total = len(sources)
    for i, src in enumerate(sources):
        clip_id = str(src["id"])
        clip_file = project_dir / src["file"]
        emit({"event": "progress", "stage": "frames", "step": i + 1, "total": total,
              "message": clip_file.name})
        clip_frames_dir = frames_dir / clip_id
        clip_dur = media_duration(clip_file)
        scene_frames = extract_dub_budget_frames(
            clip_file, clip_frames_dir, clip_id=clip_id, duration_sec=clip_dur
        )
        edge_frames = extract_edge_frames(clip_file, clip_frames_dir, clip_id=clip_id)
        opening = [f for f in edge_frames if f.get("edge") == "opening"]
        closing = [f for f in edge_frames if f.get("edge") == "closing"]
        # Same ordering the server pipeline sends to the model.
        all_frames.extend(opening + scene_frames + closing)

    manifest: list[dict[str, Any]] = []
    for fr in all_frames:
        frame_path = Path(fr["frame_path"])
        entry: dict[str, Any] = {
            "name": frame_path.name,
            "clip_id": fr["clip_id"],
            "time": fr["time"],
            "scene_idx": fr.get("scene_idx", 0),
            "scene_start": fr.get("scene_start", 0.0),
            "scene_end": fr.get("scene_end", 0.0),
            "file": str(frame_path.relative_to(project_dir).as_posix()),
        }
        if fr.get("edge"):
            entry["edge"] = fr["edge"]
        manifest.append(entry)

    frames_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = frames_dir / "frames_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "event": "done",
        "manifest": str(manifest_path),
        "frameCount": len(manifest),
    }
