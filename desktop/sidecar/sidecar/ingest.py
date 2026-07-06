"""Ingest command — copy source clips into the local project dir.

Mirrors the worker's ingest for dub_first: verbatim copy (no re-encode) to
``normalized/norm_NNN<ext>`` + ``upload_sources.json``, and enforces the same
per-clip duration cap.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.ffmpeg_bin import has_audio_stream, media_duration, video_stream_info  # noqa: E402
from packages.video.scene import DUB_MAX_CLIP_SEC, dub_clip_exceeds_upload_limit  # noqa: E402


class IngestJob(BaseModel):
    projectDir: Path
    sources: list[Path] = Field(min_length=1)


def run_ingest(job: IngestJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    norm_dir = project_dir / "normalized"
    norm_dir.mkdir(parents=True, exist_ok=True)

    clips: list[dict[str, Any]] = []
    sources_manifest: list[dict[str, Any]] = []
    total = len(job.sources)
    for i, src in enumerate(job.sources):
        if not src.is_file():
            raise FileNotFoundError(f"source clip not found: {src}")
        emit({"event": "progress", "stage": "ingest", "step": i + 1, "total": total,
              "message": src.name})

        dur = media_duration(src)
        if dub_clip_exceeds_upload_limit(dur):
            raise ValueError(
                f"คลิป {src.name} ยาว {dur:.0f}s เกินลิมิต {DUB_MAX_CLIP_SEC}s ของโหมด dub_first"
            )

        ext = src.suffix.lower() or ".mp4"
        dest = norm_dir / f"norm_{i:03d}{ext}"
        shutil.copy2(src, dest)

        try:
            info = video_stream_info(dest)
        except StopIteration:
            raise ValueError(f"{src.name} ไม่มี video stream") from None
        clip = {
            "id": f"clip{i}",
            "file": f"normalized/{dest.name}",
            "durationSec": round(dur, 3),
            "width": info["width"],
            "height": info["height"],
            "fps": info["fps"],
            "hasAudio": has_audio_stream(dest),
        }
        clips.append(clip)
        sources_manifest.append({"id": clip["id"], "file": clip["file"], "original": str(src)})

    (project_dir / "upload_sources.json").write_text(
        json.dumps(sources_manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"event": "done", "clips": clips}
