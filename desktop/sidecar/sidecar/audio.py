"""Extract-audio command — speech WAVs for server-side Whisper.

Produces the exact same mono 16 kHz loudnorm WAVs the server worker extracts
(``packages/video/audio_extract.py``), so transcription quality is identical.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel

from sidecar.bootstrap import ensure_backend_on_path

ensure_backend_on_path()

from packages.video.audio_extract import extract_speech_wav  # noqa: E402
from packages.video.ffmpeg_bin import has_audio_stream  # noqa: E402


class ExtractAudioJob(BaseModel):
    projectDir: Path


def run_extract_audio(job: ExtractAudioJob, emit) -> dict[str, Any]:
    project_dir = job.projectDir
    norm_files = sorted((project_dir / "normalized").glob("norm_*.*"))
    if not norm_files:
        raise FileNotFoundError("no normalized clips — run ingest first")

    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    for stale in audio_dir.glob("audio_*.wav"):
        stale.unlink(missing_ok=True)

    wavs: list[dict[str, Any]] = []
    total = len(norm_files)
    for i, src in enumerate(norm_files):
        if not has_audio_stream(src):
            raise ValueError(f"คลิป {src.name} ไม่มีเสียง — โหมด talking head ต้องมีเสียงพูดในวิดีโอ")
        emit({"event": "progress", "stage": "audio", "step": i + 1, "total": total,
              "message": src.name})
        wav_out = audio_dir / f"audio_{i:03d}.wav"
        extract_speech_wav(src, wav_out)
        wavs.append({
            "file": f"audio/{wav_out.name}",
            "name": wav_out.name,
            "bytes": wav_out.stat().st_size,
        })

    return {"event": "done", "wavs": wavs}
