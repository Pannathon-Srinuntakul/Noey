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
    stream = ffmpeg.input(str(src), **hwaccel_input_kwargs()).output(
        str(tmp),
        **video_encode_kwargs(crf=20, preset="veryfast"),
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


# (encoder, extra ffmpeg-python output kwargs) — checked in this order.
# NVENC/QSV/AMF are Windows+Linux (whichever GPU vendor is actually present);
# VideoToolbox is macOS. Each candidate is a REAL probe encode, not just "is
# it listed" — some ffmpeg builds list qsv/amf with no working driver behind
# them, which fails loudly on the first real render instead of falling back.
_HW_ENCODER_CANDIDATES: list[tuple[str, dict[str, str]]] = [
    ("h264_nvenc", {"preset": "p4", "cq": "18", "rc": "vbr"}),
    ("h264_qsv", {"preset": "medium", "global_quality": "18"}),
    ("h264_amf", {"quality": "quality", "rc": "cqp", "qp_i": "18", "qp_p": "20"}),
    ("h264_videotoolbox", {"q:v": "65"}),
]
_hw_encoder_cache: tuple[str, dict[str, str]] | None | Any = "unset"


def _detect_hw_encoder() -> tuple[str, dict[str, str]] | None:
    """Probe for a working hardware H.264 encoder with a throwaway 0.5s
    encode; cached for the process lifetime. Returns None if none work
    (software libx264 is always the safe fallback)."""
    global _hw_encoder_cache
    if _hw_encoder_cache != "unset":
        return _hw_encoder_cache  # type: ignore[return-value]

    import subprocess
    import tempfile

    for encoder, extra in _HW_ENCODER_CANDIDATES:
        try:
            with tempfile.TemporaryDirectory() as td:
                out = str(Path(td) / "probe.mp4")
                args = [
                    ffmpeg_cmd(), "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=10",
                    "-c:v", encoder,
                ]
                for k, v in extra.items():
                    args += [f"-{k}", str(v)]
                args += ["-y", out]
                result = subprocess.run(args, capture_output=True, timeout=15)
                if result.returncode == 0 and Path(out).stat().st_size > 0:
                    log.info("hw_encoder_detected", encoder=encoder)
                    _hw_encoder_cache = (encoder, extra)
                    return _hw_encoder_cache
        except Exception:
            continue
    log.info("hw_encoder_none_found", fallback="libx264")
    _hw_encoder_cache = None
    return None


_hwaccel_decode_cache: bool | Any = "unset"


def _detect_hwaccel_decode() -> bool:
    """Probe whether hardware-accelerated decode actually works end-to-end on
    this machine (real encode → real decode + trim filter, not just 'does
    ffmpeg accept the flag') — cached for the process lifetime. Encoding
    alone only accelerates half the pipeline: reading/decoding the source
    file before any filter (trim/scale/crop/overlay) runs is a separate,
    equally CPU-heavy step. False means every input() skips the flag and
    decodes on CPU exactly as before (zero behavior change, zero risk)."""
    global _hwaccel_decode_cache
    if _hwaccel_decode_cache != "unset":
        return _hwaccel_decode_cache  # type: ignore[return-value]

    import subprocess
    import tempfile

    ok = False
    try:
        with tempfile.TemporaryDirectory() as td:
            src = str(Path(td) / "src.mp4")
            out = str(Path(td) / "out.mp4")
            # Need a real encoded stream to decode (unlike encoder probing,
            # a synthetic lavfi source has nothing to decode from).
            mk_src = subprocess.run(
                [ffmpeg_cmd(), "-hide_banner", "-loglevel", "error",
                 "-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=10",
                 "-c:v", "libx264", "-y", src],
                capture_output=True, timeout=15,
            )
            if mk_src.returncode == 0:
                result = subprocess.run(
                    [ffmpeg_cmd(), "-hide_banner", "-loglevel", "error",
                     "-hwaccel", "auto", "-i", src,
                     "-vf", "trim=duration=0.2,setpts=PTS-STARTPTS",
                     "-c:v", "libx264", "-y", out],
                    capture_output=True, timeout=15,
                )
                ok = result.returncode == 0 and Path(out).stat().st_size > 0
    except Exception:
        ok = False

    log.info("hwaccel_decode_probe", available=ok)
    _hwaccel_decode_cache = ok
    return ok


def hwaccel_input_kwargs() -> dict[str, Any]:
    """ffmpeg-python INPUT kwargs enabling hardware-accelerated decode when
    this machine actually supports it (probed once, cached). Pass as
    ``ffmpeg.input(str(path), **hwaccel_input_kwargs())``. Returns ``{}``
    (today's plain software decode) when unavailable — every filter already
    in use here (trim/atrim/setpts/zoompan/crop/overlay) was verified
    compatible with ``-hwaccel auto`` decode before this was wired in.
    """
    return {"hwaccel": "auto"} if _detect_hwaccel_decode() else {}


def video_encode_kwargs(*, crf: int = 18, preset: str = "fast") -> dict[str, Any]:
    """ffmpeg-python output kwargs for the best available H.264 encoder.

    Re-encode-heavy renders (many per-cut trims + a full-video caption
    burn-in pass) are dominated by CPU time on software libx264. Hardware
    encoding (NVENC/QSV/AMF/VideoToolbox) moves that work onto the GPU when
    the machine actually has a working one — often cutting CPU load by
    70-90%+ with no correctness change. Falls back to the existing
    crf/preset libx264 settings when no hardware encoder is available.
    """
    hw = _detect_hw_encoder()
    if hw is None:
        return {"vcodec": "libx264", "crf": crf, "preset": preset}
    encoder, extra = hw
    return {"vcodec": encoder, **extra}


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
    inp = ffmpeg.input(str(input_path), **hwaccel_input_kwargs())
    v = (
        inp.video
        .filter("zoompan", z=zoom_expr, d=zoom_frames, s="1080x1920", fps=fps)
        .filter("setpts", "PTS-STARTPTS")
    )
    a = inp.audio
    run_ffmpeg(
        ffmpeg.output(
            v, a, str(output_path),
            **video_encode_kwargs(),
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

    inp = ffmpeg.input(str(input_path), **hwaccel_input_kwargs())
    v = inp.video.filter("trim", start=start, duration=duration).filter("setpts", "PTS-STARTPTS")
    a = inp.audio.filter("atrim", start=start, duration=duration).filter("asetpts", "PTS-STARTPTS")
    run_ffmpeg(
        ffmpeg.output(
            v,
            a,
            str(output_path),
            **video_encode_kwargs(),
            acodec="aac",
            audio_bitrate="192k",
            avoid_negative_ts="make_zero",
        ).overwrite_output(),
        label="render_cut",
    )
