"""Sidecar CLI — spawned by the Electron main process.

Commands (all output is JSON, one object per line, on stdout):

- ``ping``                    → ffmpeg availability + resolved paths
- ``probe FILE``              → duration / dimensions / fps / audio presence (audio-only OK)
- ``render --job F``          → generic cut-list render (trim + concat)
- ``ingest --job F``          → copy sources → normalized/ + upload_sources.json
- ``extract-frames --job F``  → Vision sample frames + frames_manifest.json
- ``extract-proxy --job F``   → downscaled no-audio proxy MP4s + proxy_manifest.json
- ``render-silent --job F``   → edit script → final_silent.mp4 + script.txt + dub_bundle.zip
- ``render-final --job F``    → timeline + voiceover → final.mp4 (+ final_bundle.zip)

Exit code 0 on success, 1 on any error (last line is the error event).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sidecar.bootstrap import configure_stderr_logging, ensure_backend_on_path
from sidecar.jobs import emit, load_job, run_render

ensure_backend_on_path()
configure_stderr_logging()

from packages.video.ffmpeg_bin import (  # noqa: E402
    ffmpeg_cmd,
    ffprobe_cmd,
    has_audio_stream,
    media_duration,
    probe_media,
)


def cmd_ping(_: argparse.Namespace) -> int:
    emit({"event": "pong", "ffmpeg": ffmpeg_cmd(), "ffprobe": ffprobe_cmd()})
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.is_file():
        raise FileNotFoundError(f"file not found: {path}")
    meta = probe_media(path)
    video = next((s for s in meta.get("streams", []) if s.get("codec_type") == "video"), None)
    payload: dict = {
        "event": "probe",
        "file": str(path),
        "duration": round(media_duration(path), 3),
        "has_audio": has_audio_stream(path),
        "width": None,
        "height": None,
        "fps": None,
    }
    if video is not None:
        fps_raw = video.get("r_frame_rate") or video.get("avg_frame_rate") or "30/1"
        if "/" in str(fps_raw):
            num, den = str(fps_raw).split("/", 1)
            fps = round(int(num) / max(int(den), 1))
        else:
            fps = round(float(fps_raw))
        payload.update(width=int(video["width"]), height=int(video["height"]), fps=max(fps, 1))
    emit(payload)
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    job = load_job(args.job)
    emit(run_render(job, on_progress=emit))
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    from sidecar.dub import load_json_job
    from sidecar.ingest import IngestJob, run_ingest

    job = load_json_job(args.job, IngestJob)
    emit(run_ingest(job, emit))
    return 0


def cmd_extract_frames(args: argparse.Namespace) -> int:
    from sidecar.dub import load_json_job
    from sidecar.frames import ExtractFramesJob, run_extract_frames

    job = load_json_job(args.job, ExtractFramesJob)
    emit(run_extract_frames(job, emit))
    return 0


def cmd_extract_proxy(args: argparse.Namespace) -> int:
    from sidecar.dub import load_json_job
    from sidecar.proxy import ExtractProxyJob, run_extract_proxy

    job = load_json_job(args.job, ExtractProxyJob)
    emit(run_extract_proxy(job, emit))
    return 0


def cmd_render_silent(args: argparse.Namespace) -> int:
    from sidecar.dub import RenderSilentJob, load_json_job, run_render_silent

    job = load_json_job(args.job, RenderSilentJob)
    emit(run_render_silent(job, emit))
    return 0


def cmd_render_final(args: argparse.Namespace) -> int:
    from sidecar.dub import RenderFinalJob, load_json_job, run_render_final

    job = load_json_job(args.job, RenderFinalJob)
    emit(run_render_final(job, emit))
    return 0


def cmd_extract_audio(args: argparse.Namespace) -> int:
    from sidecar.audio import ExtractAudioJob, run_extract_audio
    from sidecar.dub import load_json_job

    job = load_json_job(args.job, ExtractAudioJob)
    emit(run_extract_audio(job, emit))
    return 0


def cmd_render_timeline(args: argparse.Namespace) -> int:
    from sidecar.dub import load_json_job
    from sidecar.timeline_render import RenderTimelineJob, run_render_timeline

    job = load_json_job(args.job, RenderTimelineJob)
    emit(run_render_timeline(job, emit))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sidecar", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("ping", help="check ffmpeg availability").set_defaults(fn=cmd_ping)

    p_probe = sub.add_parser("probe", help="probe a media file")
    p_probe.add_argument("file")
    p_probe.set_defaults(fn=cmd_probe)

    for name, fn, help_text in (
        ("render", cmd_render, "run a generic cut-list render job"),
        ("ingest", cmd_ingest, "copy source clips into a project dir"),
        ("extract-frames", cmd_extract_frames, "sample Vision frames from normalized clips"),
        ("extract-proxy", cmd_extract_proxy, "encode downscaled no-audio proxy MP4s for Gemini video analysis"),
        ("render-silent", cmd_render_silent, "render silent dub video from an edit script"),
        ("render-final", cmd_render_final, "render final video from timeline + voiceover"),
        ("extract-audio", cmd_extract_audio, "extract speech WAVs for server transcription"),
        ("render-timeline", cmd_render_timeline, "render talking_head video from a timeline"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--job", required=True, help="path to job JSON file")
        p.set_defaults(fn=fn)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except Exception as exc:  # emit a machine-readable error, then non-zero exit
        emit({"event": "error", "message": str(exc), "type": type(exc).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
