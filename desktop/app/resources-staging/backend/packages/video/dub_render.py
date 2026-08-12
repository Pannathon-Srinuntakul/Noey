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
from packages.video.ffmpeg_bin import hwaccel_input_kwargs, run_ffmpeg, video_encode_kwargs

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
    clip_out = clips_dir / f"clip_{index + 1:03d}.mp4"
    log.info("render_dub_clip", idx=index + 1, total=total, src=src.name, in_=round(src_in, 2), out=round(src_out, 2))
    # Frame-accurate trim via video filter + reset PTS (avoids keyframe-stutter from vcodec=copy).
    # Re-encode to h264/yuv420p so concat timestamps are always consistent.
    run_ffmpeg(
        ffmpeg_lib.input(str(src), **hwaccel_input_kwargs())
        .video
        .filter("trim", start=src_in, end=src_out)
        .filter("setpts", "PTS-STARTPTS")
        .output(str(clip_out),
                **video_encode_kwargs(),
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


def build_dub_bundle_zip(
    final_path: Path,
    script_path: Path,
    clip_paths: list[Path],
    zip_path: Path,
    *,
    music_mixed_path: Path | None = None,
) -> None:
    """final_silent.mp4 + script.txt + per-scene clips → dub_bundle.zip.

    ``music_mixed_path`` — when a music track is attached, the mix_audio_layers
    output (video + music, no VO — see mix_audio_layers) is included as
    final_with_music.mp4 alongside the untouched silent file, so the bundle
    carries audible output even for a project that never gets a voiceover.
    Always written mode="w" (fresh), so repeated calls (e.g. after re-mixing
    music post-hoc) never leave stale/duplicate entries.
    """
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(final_path, "final_silent.mp4")
        zf.write(script_path, "script.txt")
        for cp in clip_paths:
            zf.write(cp, f"clips/{cp.name}")
        if music_mixed_path is not None and music_mixed_path.is_file():
            zf.write(music_mixed_path, "final_with_music.mp4")


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


def _music_stream(ffmpeg_lib, music_path: Path, *, volume: float, offset_sec: float, trim_in_sec: float):
    """Shared music-input filter chain (trim → offset delay → volume) for both
    mix_audio_layers branches below."""
    music_kwargs = {"ss": trim_in_sec} if trim_in_sec > 0 else {}
    stream = ffmpeg_lib.input(str(music_path), **music_kwargs).audio
    if offset_sec > 0:
        delay_ms = int(round(offset_sec * 1000))
        stream = stream.filter("adelay", delays=f"{delay_ms}|{delay_ms}")
    return stream.filter("volume", volume)


def mix_audio_layers(
    video_in: Path,
    vo_path: Path | None,
    music_path: Path | None,
    out_path: Path,
    *,
    music_volume: float = 0.25,
    music_offset_sec: float = 0.0,
    music_trim_in_sec: float = 0.0,
) -> None:
    """VO and/or background music mixed onto the (silent) video, video stream-
    copied. ``vo_path`` is optional — dub_first's voiceover step is itself
    optional (creator can finish on the AI's silent cut alone), so a project
    with only music attached and no VO must still get audible output.
    ``music_offset_sec``/``music_trim_in_sec`` come from the desktop
    TimelineEditor's audio-track drag/trim; the editable layers themselves live
    only in the desktop-local project state, never in this render step.

    - vo + no music → identical to mux_voiceover (kept as the fast path).
    - vo + music → both layers amix'd, VO always full volume, output length
      bounded by the VO (amix duration="first") then by the video (-shortest).
    - music only (no vo) → music alone mapped in, output length bounded by the
      video's own length (-shortest) — no VO to match, nothing to rescale.
    - neither → programming error; callers must not reach this without at
      least one audio layer to mix.
    """
    if music_path is None and vo_path is None:
        raise ValueError("mix_audio_layers needs at least one of vo_path/music_path")
    if music_path is None:
        assert vo_path is not None
        mux_voiceover(video_in, vo_path, out_path)
        return

    import ffmpeg as ffmpeg_lib

    video_stream = ffmpeg_lib.input(str(video_in)).video
    music_stream = _music_stream(
        ffmpeg_lib, music_path,
        volume=music_volume, offset_sec=music_offset_sec, trim_in_sec=music_trim_in_sec,
    )

    if vo_path is None:
        audio_out = music_stream
    else:
        vo_stream = ffmpeg_lib.input(str(vo_path)).audio
        audio_out = ffmpeg_lib.filter(
            [vo_stream, music_stream], "amix", inputs=2, duration="first", dropout_transition=0
        )

    run_ffmpeg(
        ffmpeg_lib.output(
            video_stream, audio_out, str(out_path),
            vcodec="copy", acodec="aac", audio_bitrate="192k", shortest=None,
        )
        .global_args("-shortest")
        .overwrite_output(),
        label="render_music_mix",
    )
