"""Extract-proxy command — encode downscaled, no-audio proxy MP4s for Gemini video analysis.

For each source clip, encodes ``proxy/{clip_id}.mp4`` (480p, ~12fps, no audio,
low-bitrate H.264) and writes ``proxy/proxy_manifest.json`` matching the
backend POST /videos/{uid}/analyze-video manifest schema
({clip_id, file, durationSec, order}).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.ffmpeg_bin import media_duration, run_ffmpeg  # noqa: E402


class ExtractProxyJob(BaseModel):
    projectDir: Path


def _encode_proxy(src: Path, dest: Path) -> None:
    import ffmpeg

    inp = ffmpeg.input(str(src))
    v = inp.video.filter("scale", -2, 480).filter("fps", fps=12)
    stream = ffmpeg.output(
        v,
        str(dest),
        vcodec="libx264",
        preset="veryfast",
        crf=28,
        an=None,
        movflags="+faststart",
    ).overwrite_output()
    run_ffmpeg(stream, label="extract_proxy")


def run_extract_proxy(job: ExtractProxyJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    sources_file = project_dir / "upload_sources.json"
    if not sources_file.is_file():
        raise FileNotFoundError("upload_sources.json missing — run ingest first")
    sources = json.loads(sources_file.read_text(encoding="utf-8"))

    proxy_dir = project_dir / "proxy"
    proxy_dir.mkdir(parents=True, exist_ok=True)

    manifest: list[dict[str, Any]] = []
    total = len(sources)
    for i, src in enumerate(sources):
        clip_id = str(src["id"])
        clip_file = project_dir / src["file"]
        emit({"event": "progress", "stage": "proxy", "step": i + 1, "total": total,
              "message": clip_file.name})

        dest = proxy_dir / f"{clip_id}.mp4"
        _encode_proxy(clip_file, dest)
        manifest.append({
            "clip_id": clip_id,
            "file": dest.name,
            "durationSec": round(media_duration(clip_file), 3),
            "order": i,
        })

    manifest_path = proxy_dir / "proxy_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "event": "done",
        "proxies": manifest,
        "count": len(manifest),
    }
