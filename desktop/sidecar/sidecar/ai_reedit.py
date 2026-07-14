"""Render an ephemeral silent proxy of the CURRENT (possibly unsaved) editor
state, for an AI re-edit request to review — never touches the project's
real final_silent.mp4 or clips/ dir, so an in-progress AI edit can't corrupt
a render the user hasn't saved yet.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.dub_render import concat_stream_copy, prepare_clips_dir, trim_one_segment  # noqa: E402
from packages.video.ffmpeg_bin import media_duration  # noqa: E402
from packages.video.timeline import normalize_dub_edit_script  # noqa: E402
from sidecar.proxy import encode_proxy  # noqa: E402


class RenderAiPreviewJob(BaseModel):
    projectDir: Path
    editScript: dict[str, Any]


def _norm_files(project_dir: Path) -> list[Path]:
    files = sorted((project_dir / "normalized").glob("norm_*.*"))
    if not files:
        raise FileNotFoundError("no normalized clips — run ingest first")
    return files


def run_render_ai_preview(job: RenderAiPreviewJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    edit_script = normalize_dub_edit_script(job.editScript)
    segments = edit_script.get("segments", [])
    if not segments:
        raise ValueError("Edit script has no segments")

    norm_files = _norm_files(project_dir)
    preview_dir = project_dir / "ai_reedit"
    preview_dir.mkdir(exist_ok=True)
    clips_dir = preview_dir / "clips"
    prepare_clips_dir(clips_dir)

    clip_paths: list[Path] = []
    total = len(segments)
    for i, seg in enumerate(segments):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        clip_paths.append(trim_one_segment(norm_files, seg, clips_dir, i, total))

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    silent_path = preview_dir / "edited_silent.mp4"
    concat_stream_copy(clip_paths, silent_path, preview_dir / "concat_preview.txt")

    emit({"event": "progress", "stage": "proxy", "step": total, "total": total})
    preview_path = preview_dir / "edited_preview.mp4"
    encode_proxy(silent_path, preview_path, keep_audio=False)
    silent_path.unlink(missing_ok=True)

    return {
        "event": "done",
        "preview": str(preview_path),
        "durationSec": round(media_duration(preview_path), 3),
        "segments": total,
    }
