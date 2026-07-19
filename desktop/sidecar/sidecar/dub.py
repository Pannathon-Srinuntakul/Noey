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
    mix_audio_layers,
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
    # Background music, attached before VO ever exists (dub_first's VO is
    # optional) — when present, final_silent_music.mp4 is produced alongside
    # the untouched final_silent.mp4 so the silent cut has audible output.
    musicPath: Path | None = None
    musicVolume: float = 0.25
    musicOffsetSec: float = 0.0
    musicTrimInSec: float = 0.0


class RenderFinalJob(BaseModel):
    projectDir: Path
    timeline: dict[str, Any]
    voiceoverPath: Path
    # Background music (desktop-local file — see TimelineEditor's audio track).
    # None/absent → identical output to the old VO-only mux.
    musicPath: Path | None = None
    musicVolume: float = 0.25
    musicOffsetSec: float = 0.0
    musicTrimInSec: float = 0.0

    def voiceover_exists(self) -> bool:
        return self.voiceoverPath.is_file()


class MixMusicJob(BaseModel):
    """Re-mix music onto an EXISTING final_silent.mp4 — for music attached or
    edited (volume/offset/trim/removed) after the silent cut already exists.
    Idempotent/repeatable: always rebuilds final_silent_music.mp4 + the zip
    fresh from what's currently on disk."""
    projectDir: Path
    musicPath: Path | None = None
    musicVolume: float = 0.25
    musicOffsetSec: float = 0.0
    musicTrimInSec: float = 0.0


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
    # ffmpeg's trim re-encodes to the nearest real video frame, so each clip's
    # actual output duration can differ from the edit script's nominal
    # sourceOut-sourceIn by a few ms — harmless alone, but the desktop app
    # sums these nominal values cumulatively to build scene-cut boundaries
    # for the effects layer (buildEffectsCutPoints), so the rounding error
    # ACCUMULATES across segments and later cuts drift further off (live
    # report 2026-07-19: punch-zoom overshooting into the next scene, worse
    # later in the video). Report the MEASURED per-clip durations so the
    # caller can build cut points from real output timing instead.
    clip_durations_sec: list[float] = []
    total = len(segments)
    for i, seg in enumerate(segments):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        clip_out = trim_one_segment(norm_files, seg, clips_dir, i, total)
        clip_paths.append(clip_out)
        clip_durations_sec.append(round(media_duration(clip_out), 3))

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    final_path = project_dir / "final_silent.mp4"
    concat_stream_copy(clip_paths, final_path, project_dir / "concat_silent.txt")

    script_path = project_dir / "script.txt"
    write_dub_script_txt(segments, job.brief, script_path)

    music_mixed_path: Path | None = None
    if job.musicPath is not None:
        emit({"event": "progress", "stage": "music", "step": total, "total": total})
        music_mixed_path = project_dir / "final_silent_music.mp4"
        mix_audio_layers(
            final_path, None, job.musicPath, music_mixed_path,
            music_volume=job.musicVolume,
            music_offset_sec=job.musicOffsetSec,
            music_trim_in_sec=job.musicTrimInSec,
        )

    emit({"event": "progress", "stage": "bundle", "step": total, "total": total})
    zip_path = project_dir / "dub_bundle.zip"
    build_dub_bundle_zip(final_path, script_path, clip_paths, zip_path, music_mixed_path=music_mixed_path)

    return {
        "event": "done",
        "finalSilent": str(final_path),
        "finalSilentMusic": str(music_mixed_path) if music_mixed_path else None,
        "script": str(script_path),
        "zip": str(zip_path),
        "durationSec": round(media_duration(final_path), 3),
        "clipDurationsSec": clip_durations_sec,
        "segments": total,
    }


def run_mix_music(job: MixMusicJob, emit) -> dict[str, Any]:
    """Re-mix music onto the existing final_silent.mp4 — for music attached,
    edited, or removed AFTER the silent cut already exists (the inline path in
    run_render_silent only covers music present before that render). Rebuilds
    dub_bundle.zip fresh each time, so repeated calls never leave stale state."""
    project_dir = job.projectDir
    final_path = project_dir / "final_silent.mp4"
    if not final_path.is_file():
        raise FileNotFoundError("final_silent.mp4 not found — run the silent render first")
    script_path = project_dir / "script.txt"
    clip_paths = sorted((project_dir / "clips").glob("clip_*.mp4"))

    music_mixed_path = project_dir / "final_silent_music.mp4"
    if job.musicPath is None:
        music_mixed_path.unlink(missing_ok=True)
        music_mixed_path = None
    else:
        emit({"event": "progress", "stage": "music", "step": 1, "total": 1})
        mix_audio_layers(
            final_path, None, job.musicPath, music_mixed_path,
            music_volume=job.musicVolume,
            music_offset_sec=job.musicOffsetSec,
            music_trim_in_sec=job.musicTrimInSec,
        )

    emit({"event": "progress", "stage": "bundle", "step": 1, "total": 1})
    zip_path = project_dir / "dub_bundle.zip"
    build_dub_bundle_zip(final_path, script_path, clip_paths, zip_path, music_mixed_path=music_mixed_path)

    return {
        "event": "done",
        "finalSilentMusic": str(music_mixed_path) if music_mixed_path else None,
        "zip": str(zip_path),
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
        clip_out = clips_dir / f"clip_{i + 1:03d}.mp4"
        dur = float(cut["out"]) - float(cut["in"])
        trim_media(src, clip_out, float(cut["in"]), dur)
        clip_paths.append(clip_out)

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    concat_out = project_dir / "final_noaudio.mp4"
    concat_stream_copy(clip_paths, concat_out, project_dir / "concat_final.txt")

    emit({"event": "progress", "stage": "mux", "step": total, "total": total})
    final_path = project_dir / "final.mp4"
    mix_audio_layers(
        concat_out, job.voiceoverPath, job.musicPath, final_path,
        music_volume=job.musicVolume,
        music_offset_sec=job.musicOffsetSec,
        music_trim_in_sec=job.musicTrimInSec,
    )
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
