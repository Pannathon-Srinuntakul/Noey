"""Render-timeline command — talking_head local render.

Same output as the server's render_video default path for talking_head
timelines: per-cut re-encoded trims (audio kept) → concat stream-copy →
SRT from timeline captions → CapCut bundle zip
(shared cores in ``packages/video/render_common.py`` + ``dub_render.py``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.dub_render import concat_stream_copy, norm_for_clip, prepare_clips_dir  # noqa: E402
from packages.video.ffmpeg_bin import media_duration, trim_media  # noqa: E402
from packages.video.render_common import build_capcut_bundle, write_srt  # noqa: E402


class RenderTimelineJob(BaseModel):
    projectDir: Path
    timeline: dict[str, Any]


def run_render_timeline(job: RenderTimelineJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    timeline = job.timeline
    cuts = [c for c in timeline.get("timeline", []) if c.get("type") == "cut"]
    if not cuts:
        raise ValueError("Timeline has no cuts")

    norm_files = sorted((project_dir / "normalized").glob("norm_*.*"))
    if not norm_files:
        raise FileNotFoundError("no normalized clips — run ingest first")

    clips_dir = project_dir / "clips"
    prepare_clips_dir(clips_dir)

    clip_paths: list[Path] = []
    total = len(cuts)
    for i, cut in enumerate(cuts):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        source = str(cut.get("source", "clip0"))
        src = norm_for_clip(norm_files, source) if source.startswith("clip") else project_dir / source
        clip_out = clips_dir / f"clip_{i:03d}.mp4"
        dur = float(cut["out"]) - float(cut["in"])
        trim_media(src, clip_out, float(cut["in"]), dur)
        clip_paths.append(clip_out)

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    final_path = project_dir / "final.mp4"
    concat_stream_copy(clip_paths, final_path, project_dir / "concat_final.txt")

    captions_dir = project_dir / "captions"
    captions_dir.mkdir(exist_ok=True)
    srt_path = captions_dir / "subtitles.srt"
    write_srt(timeline.get("captions", []), srt_path)

    emit({"event": "progress", "stage": "bundle", "step": total, "total": total})
    zip_path = build_capcut_bundle(
        project_dir,
        project_uid=str(timeline.get("project_uid", project_dir.name)),
        timeline=timeline,
        cuts=cuts,
        clip_paths=clip_paths,
        final_path=final_path,
        srt_path=srt_path,
    )

    return {
        "event": "done",
        "final": str(final_path),
        "srt": str(srt_path),
        "bundle": str(zip_path),
        "durationSec": round(media_duration(final_path), 3),
        "cuts": total,
    }
