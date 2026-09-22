"""Locate the ffmpeg binary (ffmpeg-python invokes it as a subprocess)."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, NamedTuple

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


def add_silent_audio_track(path: str | Path) -> None:
    """Mux a silent stereo AAC track into a video that has none, in place.

    `trim_media(include_audio=True)` names ``[0:a]`` and dies outright on a
    source with no audio stream, and stream-copy concat needs every part to
    carry the same stream layout. Fixing that per-cut (``include_audio=False``)
    silently drops audio for the whole render, so the repair happens ONCE at
    ingest instead: every normalized clip leaves this stage with an audio
    track, real or silent. Spec matches what ``trim_media`` writes (AAC, 48 kHz,
    stereo) so later concat sees identical layouts.
    """
    import ffmpeg

    src = Path(path)
    tmp = src.with_name(src.stem + ".silent_tmp" + src.suffix)
    inp = ffmpeg.input(str(src))
    silence = ffmpeg.input("anullsrc=channel_layout=stereo:sample_rate=48000", f="lavfi")
    run_ffmpeg(
        ffmpeg.output(
            inp.video,
            silence.audio,
            str(tmp),
            vcodec="copy",
            acodec="aac",
            audio_bitrate="192k",
            shortest=None,
        ).overwrite_output(),
        label="add_silent_audio",
    )
    tmp.replace(src)


def stream_rotation(stream: dict[str, Any]) -> int:
    """Display-matrix rotation in degrees, normalised to 0/90/180/270.

    A phone clip records landscape and carries a rotation instead of being
    re-encoded, so the CODED size and the size you actually see differ.
    """
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            try:
                return int(round(float(side["rotation"]))) % 360
            except (TypeError, ValueError):
                return 0
    return 0


def video_stream_info(path: str | Path) -> dict[str, Any]:
    """Width, height, rounded fps, codec name and rotation of the video stream.

    `width`/`height` are the CODED size, exactly as ffprobe reports them. For
    the size a player (and ffmpeg's own filter graph) actually produces, use
    `display_size` — a rotated clip's two differ.
    """
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
        "rotation": stream_rotation(stream),
    }


def display_size(info: dict[str, Any]) -> tuple[int, int]:
    """The (width, height) a decoded frame comes out as, rotation applied.

    ffmpeg's filter graph auto-applies the display matrix, so a trim of a
    1920x1080 clip carrying `rotation=-90` writes a 1080x1920 file. ffprobe
    does NOT auto-rotate, so comparing raw stream dimensions against a filter's
    output silently compares two different things — which made the concat
    conform push a portrait clip to landscape (measured on a real project's
    .mov, 2026-09-07).
    """
    w, h = int(info["width"]), int(info["height"])
    return (h, w) if int(info.get("rotation", 0)) in (90, 270) else (w, h)


# Video codecs Chromium/Electron's <video> element can reliably play AND seek.
# Phone exports in HEVC (H.265) or other codecs decode/play in Electron but
# silently fail to seek — see desktop TimelineEditor investigation (2026-07-07).
BROWSER_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}


def is_browser_safe_video_codec(codec_name: str) -> bool:
    return codec_name.lower() in BROWSER_SAFE_VIDEO_CODECS


def transcode_to_h264(src: Path, dest: Path) -> None:
    """Re-encode `src` to H.264 with faststart into `dest` (may be the same
    path as `src` — writes to a temp file first, then replaces atomically).

    The RESOLUTION is the source's own: this changes the codec, not the frame.

    Audio is copied when it is already AAC, which it is for anything a phone
    produced. Re-encoding it would cost time and a generation of quality for a
    stream the browser could already play — only the video codec was ever the
    problem.
    """
    import ffmpeg

    try:
        audio_codec = next(
            (
                st.get("codec_name", "")
                for st in probe_media(src).get("streams", [])
                if st.get("codec_type") == "audio"
            ),
            "",
        )
    except Exception:  # noqa: BLE001 — a probe failure must not block the transcode
        audio_codec = ""
    audio_kwargs: dict[str, Any] = (
        {"acodec": "copy"} if audio_codec == "aac" else {"acodec": "aac", "audio_bitrate": "192k"}
    )

    tmp = dest.with_name(f".{dest.name}.transcoding{dest.suffix}")
    stream = ffmpeg.input(str(src), **hwaccel_input_kwargs()).output(
        str(tmp),
        **video_encode_kwargs(crf=20, preset="veryfast"),
        **audio_kwargs,
        movflags="+faststart",
    )
    run_ffmpeg(stream.overwrite_output(), label="transcode_to_h264")
    tmp.replace(dest)


def media_duration(path: str | Path) -> float:
    """Return container duration in seconds."""
    meta = probe_media(path)
    return float(meta.get("format", {}).get("duration", 0) or 0)


class MediaUnmeasurable(ValueError):
    """The file's length could not be determined, not even by decoding it."""


class MediaMeasure(NamedTuple):
    duration_sec: float
    #: Display size of the first video stream (0 × 0 for audio-only).
    width: int
    height: int


def _seconds(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):  # ffprobe says "N/A" for unknown
        return 0.0
    return out if out > 0 else 0.0


def _decoded_seconds(path: str | Path) -> float:
    """Length by decoding the whole file (``-f null``) — for containers that
    carry no duration header, e.g. a browser MediaRecorder WebM. Slow on long
    files, which is why it is only the fallback."""
    proc = subprocess.run(
        [ffmpeg_cmd(), "-nostdin", "-hide_banner", "-nostats", "-v", "error", "-i", str(path),
         "-f", "null", "-progress", "pipe:1", "-"],
        capture_output=True, text=True, timeout=600, check=False,
    )
    best = 0.0
    for line in proc.stdout.splitlines():
        key, _, value = line.partition("=")
        if key in ("out_time_us", "out_time_ms"):  # both are microseconds in ffmpeg ≥ 4
            best = max(best, _seconds(value) / 1_000_000)
    return best


def measure_media(path: str | Path) -> MediaMeasure:
    """Length (and video display size) of a file, FAIL CLOSED.

    For billing: every second of footage sent to a model is paid for, so a
    length that cannot be read must never count as zero. Tries the container
    header, then the longest stream, then a full decode; raises
    ``MediaUnmeasurable`` when none gives a positive length.
    """
    try:
        meta = probe_media(path)
    except Exception as exc:  # not a media file at all (re-raised below)
        raise MediaUnmeasurable(f"unreadable media: {Path(path).name}") from exc
    streams = meta.get("streams", []) or []
    duration = _seconds((meta.get("format") or {}).get("duration"))
    if duration <= 0:
        duration = max((_seconds(s.get("duration")) for s in streams), default=0.0)
    if duration <= 0:
        try:
            duration = _decoded_seconds(path)
        except Exception:  # noqa: BLE001
            duration = 0.0
    if duration <= 0:
        raise MediaUnmeasurable(f"no measurable duration: {Path(path).name}")
    width = height = 0
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is not None:
        try:
            width, height = display_size(
                {"width": video.get("width") or 0, "height": video.get("height") or 0,
                 "rotation": stream_rotation(video)}
            )
        except (TypeError, ValueError):
            width = height = 0
    return MediaMeasure(duration, int(width), int(height))


def measured_seconds(path: str | Path, fallback: float = 0.0) -> float:
    """``measure_media`` duration, or ``fallback`` when it cannot be measured —
    for callers that must not fail (the file was already measured at upload)."""
    try:
        return measure_media(path).duration_sec
    except MediaUnmeasurable:
        return max(0.0, float(fallback or 0.0))


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


class VideoGeometry(NamedTuple):
    """The shape every clip in one concat must share."""

    width: int
    height: int
    fps: int


def target_geometry(paths: Sequence[str | Path]) -> VideoGeometry:
    """The geometry a render conforms every clip to: that of its FIRST source.

    Deliberately the first source rather than, say, the largest: a project whose
    clips all match — which is nearly all of them — then produces byte-identical
    output to a pipeline with no conforming at all, so this cannot regress the
    common case.
    """
    info = video_stream_info(paths[0])
    w, h = display_size(info)
    return VideoGeometry(w, h, int(info["fps"]))


def conform_video(stream: Any, src: str | Path, target: VideoGeometry) -> Any:
    """Scale/pad/rate a trimmed video stream onto `target`, or pass it through.

    WHY THIS EXISTS. Every per-cut trim re-encodes, and the results are then
    joined with the concat DEMUXER under ``-c copy``. Stream copy muxes the
    packets verbatim, so if two cuts came from sources of different size the
    output CHANGES RESOLUTION MID-STREAM while its container header keeps
    advertising the first clip's size.

    Measured on two synthetic sources, 1080x1920 and 1920x1080, one 2-second cut
    from each (2026-09-07)::

        header:  width=1080 height=1920 nb_frames=120
        frames:  t=0.000  1080x1920
                 t=2.000  1920x1080   <-- changes here, header still says 1080x1920

    ffmpeg exits 0 and its own decoder copes, so nothing upstream notices. A
    player does not necessarily: a hardware decode path sizes its surface pool
    from the header, and a mid-stream change either forces a reconfigure (a
    visible hitch at the cut) or hands back an uninitialised surface (a solid
    green picture). That is the "บางทีมันก็กระตุก หรือคลิปจอเขียวไปเลย" report
    (2026-09-07), and it explains why it looked intermittent: single-source
    projects are fine, only mixed-source ones produce a second resolution.

    NOT measured here: which Chromium decode path breaks and how. What is
    established is that the file we were shipping is malformed in exactly the
    way that class of failure needs, and that conforming removes it.

    Nothing upstream normalizes geometry — ``sidecar/ingest.py`` copies sources
    verbatim on purpose (``normalized/`` also feeds the preview, the AI proxy
    and frame extraction) — so the conforming belongs here, on clips that are
    being re-encoded anyway and therefore get it for free.

    Letterboxes rather than crops: a portrait cut dropped into a landscape
    project loses no picture, and the pad is black like the stage behind it.
    """
    info = video_stream_info(src)
    # DISPLAY size, not the coded one: the filters below run after ffmpeg has
    # already applied the display matrix, so a rotated source is compared and
    # scaled in the orientation it actually decodes to.
    w, h = display_size(info)
    if w == target.width and h == target.height and int(info["fps"]) == target.fps:
        return stream
    log.info(
        "conform_video",
        src=Path(src).name,
        frm=f"{w}x{h}@{info['fps']}",
        to=f"{target.width}x{target.height}@{target.fps}",
    )
    return (
        stream.filter(
            "scale", target.width, target.height, force_original_aspect_ratio="decrease"
        )
        .filter("pad", target.width, target.height, "(ow-iw)/2", "(oh-ih)/2")
        .filter("setsar", 1)
        .filter("fps", fps=target.fps)
    )


def geometries_match(paths: Sequence[str | Path]) -> bool:
    """Do all these clips share width/height/fps? Guard before a stream copy."""
    if len(paths) < 2:
        return True
    first = video_stream_info(paths[0])
    key = (*display_size(first), first["fps"])
    for p in paths[1:]:
        info = video_stream_info(p)
        got = (*display_size(info), info["fps"])
        if got != key:
            log.warning(
                "concat_geometry_mismatch",
                first=f"{key[0]}x{key[1]}@{key[2]}",
                offender=Path(p).name,
                got=f"{got[0]}x{got[1]}@{got[2]}",
            )
            return False
    return True


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


#: How far before a cut the fast seek lands. Long enough to clear the gap to
#: the previous keyframe on ordinary footage, short enough that the decode from
#: there is trivial.
SEEK_PREROLL_SEC = 3.0


def trim_media(
    input_path: str | Path,
    output_path: str | Path,
    start: float,
    duration: float,
    *,
    include_audio: bool = True,
    geometry: "VideoGeometry | None" = None,
) -> None:
    """Accurate A/V trim with re-encode (trim/atrim filters keep lip-sync).

    ``include_audio=False`` skips the atrim branch entirely. Two reasons to use
    it: the caller is going to replace the audio anyway (the dub's final render
    muxes the voiceover over these clips), and — the actual bug — the atrim
    branch names ``[0:a]``, so a source with no audio track makes ffmpeg fail
    outright with "Stream specifier ':a' … matches no streams". A silent clip
    (screen recording, a phone clip with the mic off) killed the whole render.
    """
    import ffmpeg

    # Seek in the container first, decode second. Without the seek, ffmpeg opens
    # at 0 and decodes its way to the cut, so extracting 23 cuts from a 100-min
    # source means decoding that source 23 times: measured 10-12 s per cut
    # regardless of the cut's own length, 175 minutes for one podcast. Jumping
    # first makes each cut cost a fraction of a second — the same frames, ~20x
    # sooner.
    #
    # The jump lands on a keyframe, so the remaining offset is handed to the
    # trim filters rather than trusted: the cut boundary stays exact. Measured
    # against the unseeked output, sample-for-sample, the audio does not move
    # (an earlier "fix" for a 23 ms shift was chasing an artefact of comparing
    # two different encoders, and putting it in was what actually shifted the
    # sound).
    pre = max(0.0, start - SEEK_PREROLL_SEC)
    offset = start - pre
    inp = ffmpeg.input(str(input_path), ss=pre, **hwaccel_input_kwargs())
    v = inp.video.filter("trim", start=offset, duration=duration).filter("setpts", "PTS-STARTPTS")
    # These cuts are concatenated with `-c copy` downstream, which keeps only
    # the first clip's parameter set — see `conform_video` for what a mismatch
    # looks like on screen.
    if geometry is not None:
        v = conform_video(v, input_path, geometry)
    if not include_audio:
        run_ffmpeg(
            ffmpeg.output(
                v,
                str(output_path),
                **video_encode_kwargs(),
                avoid_negative_ts="make_zero",
                **{"an": None},
            ).overwrite_output(),
            label="render_cut_video_only",
        )
        return
    a = inp.audio.filter("atrim", start=offset, duration=duration).filter("asetpts", "PTS-STARTPTS")
    run_ffmpeg(
        ffmpeg.output(
            v,
            a,
            str(output_path),
            **video_encode_kwargs(),
            acodec="aac",
            audio_bitrate="192k",
            # Pin the audio shape for the same reason as the video's: a concat
            # stream copy keeps the first clip's channel layout and sample rate
            # too, so mixed-source cuts otherwise desync or drop a channel.
            ar=48000,
            ac=2,
            avoid_negative_ts="make_zero",
        ).overwrite_output(),
        label="render_cut",
    )
