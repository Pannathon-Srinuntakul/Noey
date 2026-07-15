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

from packages.video.caption import (  # noqa: E402
    build_ass_captions,
    remap_words_to_output,
    resolve_caption_style,
)
from packages.video.dub_render import concat_stream_copy, norm_for_clip, prepare_clips_dir  # noqa: E402
from packages.video.ffmpeg_bin import (  # noqa: E402
    hwaccel_input_kwargs,
    media_duration,
    run_ffmpeg,
    trim_media,
    video_encode_kwargs,
)
from packages.video.fonts import escape_ass_filter_path, fonts_dir  # noqa: E402
from packages.video.render_common import build_capcut_bundle, write_srt  # noqa: E402


def _clip_abs_offsets(norm_files: list[Path]) -> dict[str, float]:
    offsets: dict[str, float] = {}
    off = 0.0
    for i, nf in enumerate(norm_files):
        offsets[f"clip{i}"] = off
        off += media_duration(nf)
    return offsets


def _burn_captions(src: Path, ass_path: Path, dest: Path) -> None:
    import ffmpeg as ffmpeg_lib

    ass_filter = (
        f"ass={escape_ass_filter_path(ass_path)}:fontsdir={escape_ass_filter_path(fonts_dir())}"
    )
    run_ffmpeg(
        ffmpeg_lib.input(str(src), **hwaccel_input_kwargs()).output(
            str(dest),
            vf=ass_filter,
            acodec="copy",
            **video_encode_kwargs(),
        ).overwrite_output(),
        label="burn_captions",
    )


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
    # Actual rendered duration of each trimmed clip — trim_media re-encodes
    # to the nearest video frame, so the REAL output duration can differ from
    # the requested cut["out"]-cut["in"] by a frame or so. That's invisible
    # for a handful of cuts, but for a long talking_head render (100+ cuts)
    # the per-cut rounding accumulates and captions drift out of sync with
    # the audio further into the video. Captions must be timed against these
    # measured durations, not the requested ones — see below.
    actual_durations: list[float] = []
    total = len(cuts)
    for i, cut in enumerate(cuts):
        emit({"event": "progress", "stage": "cut", "step": i + 1, "total": total})
        source = str(cut.get("source", "clip0"))
        src = norm_for_clip(norm_files, source) if source.startswith("clip") else project_dir / source
        clip_out = clips_dir / f"clip_{i + 1:03d}.mp4"
        dur = float(cut["out"]) - float(cut["in"])
        trim_media(src, clip_out, float(cut["in"]), dur)
        clip_paths.append(clip_out)
        actual_durations.append(media_duration(clip_out))

    emit({"event": "progress", "stage": "concat", "step": total, "total": total})
    final_path = project_dir / "final.mp4"
    concat_stream_copy(clip_paths, final_path, project_dir / "concat_final.txt")

    captions_dir = project_dir / "captions"
    captions_dir.mkdir(exist_ok=True)
    srt_path = captions_dir / "subtitles.srt"
    write_srt(timeline.get("captions", []), srt_path)

    # Burned-in captions (talking_head only — opted into via caption_style at
    # project creation). words = raw Whisper word timestamps (source timeline);
    # captionLines = user-edited overlay from the TimelineEditor, if any.
    ass_burned = False
    words = timeline.get("words") or []
    caption_style = timeline.get("captionStyle")
    if words and caption_style:
        emit({"event": "progress", "stage": "captions", "step": total, "total": total})
        clip_abs = _clip_abs_offsets(norm_files)
        # Use each cut's ACTUAL rendered duration (not the requested in/out)
        # so caption timing tracks the real concatenated video frame-for-frame
        # instead of drifting further out of sync with every cut.
        rendered_cuts = [{**c, "out": float(c["in"]) + actual_durations[i]} for i, c in enumerate(cuts)]
        remapped = remap_words_to_output(words, rendered_cuts, clip_abs)
        if remapped:
            style, mode = resolve_caption_style(caption_style)
            output_dur = sum(actual_durations)
            ass_path = captions_dir / "subtitles.ass"
            ass_path.write_text(
                build_ass_captions(
                    remapped,
                    output_dur,
                    style=style,
                    mode=mode,
                    caption_lines=timeline.get("captionLines"),
                ),
                encoding="utf-8",
            )
            final_captioned = project_dir / "final_captions.mp4"
            _burn_captions(final_path, ass_path, final_captioned)
            final_captioned.replace(final_path)
            ass_burned = True

    emit({"event": "progress", "stage": "bundle", "step": total, "total": total})
    zip_path = build_capcut_bundle(
        project_dir,
        project_uid=str(timeline.get("project_uid", project_dir.name)),
        timeline=timeline,
        cuts=cuts,
        clip_paths=clip_paths,
        final_path=final_path,
        srt_path=srt_path,
        ass_burned=ass_burned,
    )

    return {
        "event": "done",
        "final": str(final_path),
        "srt": str(srt_path),
        "bundle": str(zip_path),
        "durationSec": round(media_duration(final_path), 3),
        "cuts": total,
    }
