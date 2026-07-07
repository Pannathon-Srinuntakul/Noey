"""Locate the ffmpeg binary (ffmpeg-python invokes it as a subprocess)."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

_FFMPEG_CMD: str | None = None
_FFPROBE_CMD: str | None = None


def resolve_ffmpeg() -> str:
    """Return absolute path to ffmpeg. Raises FileNotFoundError if missing."""
    from packages.core.settings import get_settings

    settings = get_settings()
    if settings.ffmpeg_path:
        p = Path(settings.ffmpeg_path)
        if p.is_file():
            return str(p.resolve())
        raise FileNotFoundError(f"FFMPEG_PATH not found: {settings.ffmpeg_path}")

    for env_key in ("FFMPEG_BINARY", "FFMPEG_PATH"):
        env = os.environ.get(env_key)
        if env and Path(env).is_file():
            return str(Path(env).resolve())

    found = shutil.which("ffmpeg")
    if found:
        return found

    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        winget_root = Path(local) / "Microsoft" / "WinGet"
        for candidate in (
            winget_root / "Links" / "ffmpeg.exe",
            winget_root / "Links" / "ffmpeg",
        ):
            if candidate.is_file():
                return str(candidate.resolve())
        packages = winget_root / "Packages"
        if packages.is_dir():
            for pattern in ("Gyan.FFmpeg*/**/bin/ffmpeg.exe", "Gyan.FFmpeg*/ffmpeg.exe"):
                for match in packages.glob(pattern):
                    if match.is_file():
                        return str(match.resolve())

    raise FileNotFoundError(
        "ffmpeg not found in PATH. Install it (winget install Gyan.FFmpeg) "
        "or set FFMPEG_PATH in .env to the full path of ffmpeg.exe"
    )


def configure_ffmpeg() -> str:
    """Resolve ffmpeg once and prepend its directory to PATH for subprocesses."""
    global _FFMPEG_CMD
    cmd = resolve_ffmpeg()
    _FFMPEG_CMD = cmd
    os.environ["FFMPEG_BINARY"] = cmd
    ffmpeg_dir = str(Path(cmd).parent)
    if ffmpeg_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    log.info("ffmpeg_configured", path=cmd)
    return cmd


def ffmpeg_cmd() -> str:
    """Cached ffmpeg executable path (call configure_ffmpeg() at worker startup)."""
    global _FFMPEG_CMD
    if _FFMPEG_CMD is None:
        return configure_ffmpeg()
    return _FFMPEG_CMD


def ffprobe_cmd() -> str:
    """Cached ffprobe path (sibling of ffmpeg in the same bin directory)."""
    global _FFPROBE_CMD
    if _FFPROBE_CMD is None:
        ffmpeg = Path(ffmpeg_cmd())
        probe = ffmpeg.with_name("ffprobe.exe" if ffmpeg.suffix.lower() == ".exe" else "ffprobe")
        if not probe.is_file():
            raise FileNotFoundError(f"ffprobe not found next to ffmpeg: {probe}")
        _FFPROBE_CMD = str(probe.resolve())
    return _FFPROBE_CMD


def probe_media(path: str | Path) -> dict[str, Any]:
    """Return ffprobe JSON metadata for a media file."""
    import ffmpeg

    return ffmpeg.probe(str(path), cmd=ffprobe_cmd())


def has_audio_stream(path: str | Path) -> bool:
    """True when the file contains at least one audio stream."""
    meta = probe_media(path)
    return any(s.get("codec_type") == "audio" for s in meta.get("streams", []))


def video_stream_info(path: str | Path) -> dict[str, Any]:
    """Return width, height, rounded fps, and codec name for the primary video stream."""
    meta = probe_media(path)
    stream = next(s for s in meta.get("streams", []) if s.get("codec_type") == "video")
    fps_raw = stream.get("r_frame_rate") or stream.get("avg_frame_rate") or "30/1"
    if "/" in str(fps_raw):
        num, den = str(fps_raw).split("/", 1)
        fps = round(int(num) / max(int(den), 1))
    else:
        fps = round(float(fps_raw))
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": max(fps, 1),
        "codec_name": str(stream.get("codec_name") or ""),
    }


# Video codecs Chromium/Electron's <video> element can reliably play AND seek.
# Phone exports in HEVC (H.265) or other codecs decode/play in Electron but
# silently fail to seek — see desktop TimelineEditor investigation (2026-07-07).
BROWSER_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}


def is_browser_safe_video_codec(codec_name: str) -> bool:
    return codec_name.lower() in BROWSER_SAFE_VIDEO_CODECS


def transcode_to_h264(src: Path, dest: Path) -> None:
    """Re-encode `src` to H.264/AAC with faststart into `dest` (may be the same
    path as `src` — writes to a temp file first, then replaces atomically)."""
    import ffmpeg

    tmp = dest.with_name(f".{dest.name}.transcoding{dest.suffix}")
    stream = ffmpeg.input(str(src)).output(
        str(tmp),
        vcodec="libx264",
        preset="veryfast",
        crf=20,
        acodec="aac",
        audio_bitrate="192k",
        movflags="+faststart",
    )
    run_ffmpeg(stream.overwrite_output(), label="transcode_to_h264")
    tmp.replace(dest)


def media_duration(path: str | Path) -> float:
    """Return container duration in seconds."""
    meta = probe_media(path)
    return float(meta.get("format", {}).get("duration", 0) or 0)


def run_ffmpeg(stream: Any, *, label: str = "ffmpeg") -> None:
    """Run an ffmpeg-python pipeline; log stderr and raise a readable error on failure."""
    import ffmpeg

    log.info("ffmpeg_start", label=label)
    t0 = time.monotonic()
    try:
        stream.run(quiet=True, cmd=ffmpeg_cmd())
    except ffmpeg.Error as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        tail = stderr[-2000:] if len(stderr) > 2000 else stderr
        log.error("ffmpeg_failed", label=label, elapsed_ms=round((time.monotonic() - t0) * 1000), stderr=tail)
        last_line = next(
            (line.strip() for line in reversed(tail.splitlines()) if line.strip()),
            "unknown ffmpeg error",
        )
        raise RuntimeError(f"ffmpeg ({label}): {last_line}") from exc
    log.info("ffmpeg_done", label=label, elapsed_ms=round((time.monotonic() - t0) * 1000))


def apply_zoom(
    input_path: str | Path,
    output_path: str | Path,
    scale: float = 1.1,
    duration: float = 0.25,
) -> None:
    """Punch-zoom: scale up to `scale` over `duration` seconds then hold.

    Uses zoompan filter for smooth zoom-in at clip start.
    Audio is stream-copied (zoom is video-only).
    """
    import ffmpeg

    fps = 30
    zoom_frames = max(1, round(fps * duration))
    # zoompan: zoom from 1.0 to `scale` over zoom_frames, then hold at scale
    # d=total_frames (we set to match clip via -t in output), s=output size
    zoom_expr = f"if(lte(on,{zoom_frames}),1+(on/{zoom_frames})*{scale - 1:.4f},{scale:.4f})"
    inp = ffmpeg.input(str(input_path))
    v = (
        inp.video
        .filter("zoompan", z=zoom_expr, d=zoom_frames, s="1080x1920", fps=fps)
        .filter("setpts", "PTS-STARTPTS")
    )
    a = inp.audio
    run_ffmpeg(
        ffmpeg.output(
            v, a, str(output_path),
            vcodec="libx264", preset="fast", crf=18,
            acodec="copy",
            **{"r": fps},
        ).overwrite_output(),
        label="apply_zoom",
    )


def normalize_loudness(
    input_path: str | Path,
    output_path: str | Path,
    *,
    target_i: float = -16.0,
    target_tp: float = -1.5,
    target_lra: float = 11.0,
) -> None:
    """Normalize perceived loudness to EBU R128 (single-pass loudnorm).

    Defaults (-16 LUFS / -1.5 dBTP) suit TikTok/social playback. Video is
    stream-copied; only the audio track is re-encoded.
    """
    import ffmpeg

    inp = ffmpeg.input(str(input_path))
    a = inp.audio.filter(
        "loudnorm", i=target_i, tp=target_tp, lra=target_lra
    )
    run_ffmpeg(
        ffmpeg.output(
            inp.video,
            a,
            str(output_path),
            vcodec="copy",
            acodec="aac",
            audio_bitrate="192k",
        ).overwrite_output(),
        label="loudnorm",
    )


def trim_media(input_path: str | Path, output_path: str | Path, start: float, duration: float) -> None:
    """Accurate A/V trim with re-encode (trim/atrim filters keep lip-sync)."""
    import ffmpeg

    inp = ffmpeg.input(str(input_path))
    v = inp.video.filter("trim", start=start, duration=duration).filter("setpts", "PTS-STARTPTS")
    a = inp.audio.filter("atrim", start=start, duration=duration).filter("asetpts", "PTS-STARTPTS")
    run_ffmpeg(
        ffmpeg.output(
            v,
            a,
            str(output_path),
            vcodec="libx264",
            preset="fast",
            crf=18,
            acodec="aac",
            audio_bitrate="192k",
            avoid_negative_ts="make_zero",
        ).overwrite_output(),
        label="render_cut",
    )
