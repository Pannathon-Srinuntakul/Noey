"""Render job model + runner.

A job is a JSON document::

    {
      "source": "C:/clips/raw.mp4",
      "output": "C:/renders/out.mp4",
      "cuts": [{"start": 1.0, "end": 3.5}, {"start": 8.0, "end": 12.0}]
    }

Cuts are trimmed with accurate re-encode (uniform libx264/aac params) and then
joined with the ffmpeg concat demuxer using stream copy, so the expensive
encode happens exactly once per cut.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.ffmpeg_bin import ffmpeg_cmd, media_duration, trim_media  # noqa: E402

ProgressFn = Callable[[dict], None]


class Cut(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @field_validator("end")
    @classmethod
    def end_after_start(cls, v: float, info) -> float:
        start = info.data.get("start")
        if start is not None and v <= start:
            raise ValueError(f"cut end ({v}) must be greater than start ({start})")
        return v

    @property
    def duration(self) -> float:
        return self.end - self.start


class RenderJob(BaseModel):
    source: Path
    output: Path
    cuts: list[Cut] = Field(min_length=1)

    @field_validator("source")
    @classmethod
    def source_exists(cls, v: Path) -> Path:
        if not v.is_file():
            raise ValueError(f"source file not found: {v}")
        return v


def load_job(path: str | Path) -> RenderJob:
    return RenderJob.model_validate_json(Path(path).read_text(encoding="utf-8"))


def _concat_copy(parts: list[Path], output: Path, workdir: Path) -> None:
    """Join uniformly-encoded parts with the concat demuxer (no re-encode)."""
    list_file = workdir / "concat.txt"
    # concat demuxer path syntax: single quotes, escape embedded quotes
    lines = "\n".join("file '{}'".format(str(p).replace("'", r"'\''")) for p in parts)
    list_file.write_text(lines + "\n", encoding="utf-8")
    cmd = [
        ffmpeg_cmd(),
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        str(output),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()
        last = tail[-1] if tail else "unknown ffmpeg error"
        raise RuntimeError(f"ffmpeg (concat): {last}")


def run_render(job: RenderJob, on_progress: ProgressFn) -> dict:
    """Execute the job; emit progress events; return the done payload."""
    job.output.parent.mkdir(parents=True, exist_ok=True)
    total = len(job.cuts)
    on_progress({"event": "start", "cuts": total, "source": str(job.source)})

    with tempfile.TemporaryDirectory(prefix="noey_render_") as tmp:
        workdir = Path(tmp)
        parts: list[Path] = []
        for i, cut in enumerate(job.cuts, start=1):
            part = workdir / f"part_{i:03d}.mp4"
            trim_media(job.source, part, start=cut.start, duration=cut.duration)
            parts.append(part)
            on_progress({"event": "progress", "stage": "cut", "step": i, "total": total})

        if len(parts) == 1:
            parts[0].replace(job.output)
        else:
            on_progress({"event": "progress", "stage": "concat", "step": total, "total": total})
            _concat_copy(parts, job.output, workdir)

    return {
        "event": "done",
        "output": str(job.output),
        "duration": round(media_duration(job.output), 3),
    }


def emit(payload: dict) -> None:
    """Write one JSON line to stdout (the Electron main process reads these)."""
    print(json.dumps(payload, ensure_ascii=False), flush=True)
