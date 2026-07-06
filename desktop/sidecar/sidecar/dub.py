"""Dub-first render commands — silent render + final render (VO mux).

Reuses the shared cores in ``backend/packages/video/dub_render.py`` (the same
code the server worker runs), so local output matches server output.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.dub_render import (  # noqa: E402
    build_dub_bundle_zip,
    concat_stream_copy,
    mux_voiceover,
    prepare_clips_dir,
    trim_one_segment,
)
from packages.video.dub_render import write_dub_script_txt  # noqa: E402
from packages.video.ffmpeg_bin import media_duration, trim_media  # noqa: E402
from packages.video.timeline import normalize_dub_edit_script  # noqa: E402


class RenderSilentJob(BaseModel):
    projectDir: Path
    editScript: dict[str, Any]
    brief: str | None = None


class RenderFinalJob(BaseModel):
    projectDir: Path
    timeline: dict[str, Any]
    voiceoverPath: Path

    def voiceover_exists(self) -> bool:
        return self.voiceoverPath.is_file()


def _norm_files(project_dir: Path) -> list[Path]:
    files = sorted((project_dir / "normalized").glob("norm_*.*"))
    if not files:
        raise FileNotFoundError("no normalized clips — run ingest first")
    return files


def run_render_silent(job: RenderSilentJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    edit_script = normalize_dub_edit_script(job.editScript)
    segments = edit_script.get("segments", [])
    if not segments:
        raise ValueError("Edit script has no segments")

    norm_files = _norm_files(project_dir)
    clips_dir = project_dir / "clips"
    prepare_clips_dir(clips_dir)

    clip_paths: list[Path] = []
    total = len(segments)
    for i, seg in enumerate(segments):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        clip_paths.append(trim_one_segment(norm_files, seg, clips_dir, i, total))

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    final_path = project_dir / "final_silent.mp4"
    concat_stream_copy(clip_paths, final_path, project_dir / "concat_silent.txt")

    script_path = project_dir / "script.txt"
    write_dub_script_txt(segments, job.brief, script_path)

    emit({"event": "progress", "stage": "bundle", "step": total, "total": total})
    zip_path = project_dir / "dub_bundle.zip"
    build_dub_bundle_zip(final_path, script_path, clip_paths, zip_path)

    return {
        "event": "done",
        "finalSilent": str(final_path),
        "script": str(script_path),
        "zip": str(zip_path),
        "durationSec": round(media_duration(final_path), 3),
        "segments": total,
    }


def run_render_final(job: RenderFinalJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    if not job.voiceover_exists():
        raise FileNotFoundError(f"voiceover file not found: {job.voiceoverPath}")

    cuts = [c for c in job.timeline.get("timeline", []) if c.get("type") == "cut"]
    if not cuts:
        raise ValueError("Timeline has no cuts")

    norm_files = _norm_files(project_dir)
    clips_dir = project_dir / "clips"
    prepare_clips_dir(clips_dir)

    # Same dub-relevant cut loop as the worker's render_video (no zoom/face/captions —
    # dub_first timelines don't use them).
    clip_paths: list[Path] = []
    total = len(cuts)
    for i, cut in enumerate(cuts):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        source = str(cut.get("source", "clip0"))
        if source.startswith("clip"):
            idx = int(source.replace("clip", "") or 0)
            src = norm_files[idx] if idx < len(norm_files) else norm_files[0]
        else:
            src = project_dir / source
        clip_out = clips_dir / f"clip_{i:03d}.mp4"
        dur = float(cut["out"]) - float(cut["in"])
        trim_media(src, clip_out, float(cut["in"]), dur)
        clip_paths.append(clip_out)

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    concat_out = project_dir / "final_noaudio.mp4"
    concat_stream_copy(clip_paths, concat_out, project_dir / "concat_final.txt")

    emit({"event": "progress", "stage": "mux", "step": total, "total": total})
    final_path = project_dir / "final.mp4"
    mux_voiceover(concat_out, job.voiceoverPath, final_path)
    concat_out.unlink(missing_ok=True)

    emit({"event": "progress", "stage": "bundle", "step": total, "total": total})
    bundle_path = project_dir / "final_bundle.zip"
    with zipfile.ZipFile(bundle_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(final_path, "final.mp4")
        script_path = project_dir / "script.txt"
        if script_path.is_file():
            zf.write(script_path, "script.txt")

    return {
        "event": "done",
        "final": str(final_path),
        "bundle": str(bundle_path),
        "durationSec": round(media_duration(final_path), 3),
        "cuts": total,
    }


def load_json_job(path: str | Path, model: type[BaseModel]) -> BaseModel:
    return model.model_validate_json(Path(path).read_text(encoding="utf-8"))
