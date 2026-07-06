"""Dub-first ffmpeg render cores — shared by the worker tasks and the sidecar.

Extracted verbatim from ``services/worker/tasks.py`` (render_dub_silent /
render_video VO-mux). Pure filesystem + ffmpeg: no DB, no arq, no S3. Callers
provide progress via the optional callback.
"""

from __future__ import annotations

import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from packages.core.logging import get_logger
from packages.video.ffmpeg_bin import run_ffmpeg

log = get_logger(__name__)

ProgressFn = Callable[[int, int], None]  # (current_1_based, total)


def norm_for_clip(norm_files_sorted: list[Path], clip_id: str) -> Path:
    """Map a 'clipN' id to the N-th normalized file (clamped like the worker)."""
    idx = int(clip_id.replace("clip", "")) if clip_id.startswith("clip") else 0
    return norm_files_sorted[idx] if idx < len(norm_files_sorted) else norm_files_sorted[0]


def prepare_clips_dir(clips_dir: Path) -> None:
    """Create the per-scene clips dir and drop clips from prior renders
    so clip count always matches segments."""
    clips_dir.mkdir(exist_ok=True)
    for stale in clips_dir.glob("clip_*.mp4"):
        stale.unlink(missing_ok=True)


def trim_one_segment(
    norm_files_sorted: list[Path],
    seg: dict[str, Any],
    clips_dir: Path,
    index: int,
    total: int,
) -> Path:
    """Frame-accurate silent trim of one segment (re-encoded for concat)."""
    import ffmpeg as ffmpeg_lib

    src = norm_for_clip(norm_files_sorted, seg.get("sourceClip", "clip0"))
    src_in = float(seg.get("sourceIn", 0.0))
    src_out = float(seg.get("sourceOut", src_in + 3.0))
    clip_out = clips_dir / f"clip_{index:03d}.mp4"
    log.info("render_dub_clip", idx=index + 1, total=total, src=src.name, in_=round(src_in, 2), out=round(src_out, 2))
    # Frame-accurate trim via video filter + reset PTS (avoids keyframe-stutter from vcodec=copy).
    # Re-encode to h264/yuv420p so concat timestamps are always consistent.
    run_ffmpeg(
        ffmpeg_lib.input(str(src))
        .video
        .filter("trim", start=src_in, end=src_out)
        .filter("setpts", "PTS-STARTPTS")
        .output(str(clip_out),
                vcodec="libx264", preset="fast", crf=18,
                pix_fmt="yuv420p",
                **{"an": None})
        .overwrite_output(),
        label=f"dub_trim_{index}",
    )
    return clip_out


def trim_segments_silent(
    norm_files_sorted: list[Path],
    segments: list[dict[str, Any]],
    clips_dir: Path,
    *,
    on_progress: ProgressFn | None = None,
) -> list[Path]:
    """Trim every segment (sidecar entry point; the worker drives its own loop
    so it can interleave job progress + cancellation checks)."""
    prepare_clips_dir(clips_dir)
    clip_paths: list[Path] = []
    total = len(segments)
    for i, seg in enumerate(segments):
        if on_progress:
            on_progress(i + 1, total)
        clip_paths.append(trim_one_segment(norm_files_sorted, seg, clips_dir, i, total))
    return clip_paths


def concat_stream_copy(clip_paths: list[Path], out_path: Path, list_path: Path) -> None:
    """Join re-encoded clips with the concat demuxer (stream copy + faststart)."""
    import ffmpeg as ffmpeg_lib

    base = list_path.parent
    list_path.write_text(
        "\n".join(f"file '{p.relative_to(base).as_posix()}'" for p in clip_paths),
        encoding="utf-8",
    )
    run_ffmpeg(
        ffmpeg_lib.input(str(list_path), format="concat", safe=0)
        .output(str(out_path), c="copy", movflags="+faststart")
        .overwrite_output(),
        label="dub_concat",
    )


def write_dub_script_txt(segments: list[dict[str, Any]], brief: str | None, path: Path) -> None:
    """script.txt grouped by voiceover line; montage lines note their cut count."""
    script_lines = ["=== Script ===\n"]
    if brief:
        script_lines.append(f"Brief: {brief}\n")
    script_lines.append("")
    seen_line_ids: set[int] = set()
    line_no = 0
    for seg in segments:
        lid = int(seg.get("voiceoverLineId") or seg.get("order") or 0)
        if lid in seen_line_ids:
            continue
        seen_line_ids.add(lid)
        line_no += 1
        line_segs = [
            s for s in segments
            if int(s.get("voiceoverLineId") or s.get("order") or 0) == lid
        ]
        o_in = float(line_segs[0].get("voiceoverLineOutputIn") or line_segs[0].get("outputIn") or 0)
        o_out = float(line_segs[-1].get("voiceoverLineOutputOut") or line_segs[-1].get("outputOut") or 0)
        vo = str(line_segs[0].get("voiceoverScript") or "").strip()
        montage = len(line_segs) > 1
        hdr = f"[Line {line_no} | {o_in:.1f}s → {o_out:.1f}s"
        if montage:
            hdr += f" | {len(line_segs)} cuts"
        script_lines.append(f"{hdr}]")
        script_lines.append(vo)
        script_lines.append("")
    out_t = float(segments[-1].get("outputOut") or 0) if segments else 0.0
    script_lines.append(f"===\nTotal: {out_t:.0f}s")
    path.write_text("\n".join(script_lines), encoding="utf-8")


def build_dub_bundle_zip(final_path: Path, script_path: Path, clip_paths: list[Path], zip_path: Path) -> None:
    """final_silent.mp4 + script.txt + per-scene clips → dub_bundle.zip."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(final_path, "final_silent.mp4")
        zf.write(script_path, "script.txt")
        for cp in clip_paths:
            zf.write(cp, f"clips/{cp.name}")


def mux_voiceover(video_in: Path, vo_path: Path, out_path: Path) -> None:
    """Replace the video's audio track with the voiceover (video stream-copied)."""
    import ffmpeg as ffmpeg_lib

    vo_in = ffmpeg_lib.input(str(vo_path))
    run_ffmpeg(
        ffmpeg_lib.output(
            ffmpeg_lib.input(str(video_in)).video,
            vo_in.audio,
            str(out_path),
            vcodec="copy",
            acodec="aac",
            audio_bitrate="192k",
            shortest=None,
        )
        .global_args("-shortest")
        .overwrite_output(),
        label="render_vo_replace",
    )
