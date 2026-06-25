"""Scene detection and frame extraction for dub_first mode."""

from __future__ import annotations

import base64
import pathlib
from typing import Any

from packages.core.logging import get_logger
from packages.video.ffmpeg_bin import run_ffmpeg

log = get_logger(__name__)

MAX_FRAMES = 15  # cap Claude Vision payload (talking_head)
# dub_first: sample budget scales with clip length up to DUB_MAX_CLIP_SEC.
DUB_MAX_CLIP_SEC = 20 * 60  # upload + sampling ceiling (20 minutes)
DUB_SCENE_INTERVAL_SEC = 15  # ~1 sampled scene every 15s of source → even coverage
DUB_MIN_SCENE_CAP = 6
DUB_SAMPLES_PER_SCENE = 2
# Skip early part of each scene — prep/hair-adjust usually happens at scene start.
DUB_LEAD_SKIP_PCT = 0.25
DUB_SAMPLE_PCTS = (0.5, 0.75)  # sample within the post-skip portion of each scene
# Extra clip-edge samples (added on top of scene sampling, not counted in max_frames).
DUB_EDGE_OFFSET_SEC = 5.0  # opening at 5s; closing at duration − 5s


def dub_scene_cap(duration_sec: float) -> int:
    """How many time slots to sample for Vision (evenly spaced), from clip duration."""
    dur = min(max(float(duration_sec), 0.0), float(DUB_MAX_CLIP_SEC))
    if dur <= 0:
        return 0
    return max(DUB_MIN_SCENE_CAP, round(dur / DUB_SCENE_INTERVAL_SEC))


def dub_sample_frame_budget(
    duration_sec: float,
    *,
    samples_per_scene: int = DUB_SAMPLES_PER_SCENE,
) -> int:
    """Max scene JPEGs to extract (excludes opening/closing edge frames)."""
    return dub_scene_cap(duration_sec) * max(1, samples_per_scene)


def detect_scenes(video_path: pathlib.Path, threshold: float = 27.0) -> list[dict[str, Any]]:
    """Return list of {"start": float, "end": float, "duration": float} in seconds."""
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    video = open_video(str(video_path))
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=threshold))
    manager.detect_scenes(video)
    scenes = manager.get_scene_list()

    result = []
    for start_tc, end_tc in scenes:
        start = start_tc.get_seconds()
        end = end_tc.get_seconds()
        result.append({"start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3)})

    # Always return at least one scene (whole clip) if detection finds nothing
    if not result:
        from packages.video.ffmpeg_bin import media_duration
        dur = media_duration(video_path)
        result = [{"start": 0.0, "end": dur, "duration": round(dur, 3)}]

    log.info("scenes_detected", path=str(video_path), count=len(result))
    return result


def _sample_time_in_scene(scene: dict[str, Any], pct: float, *, lead_skip_pct: float) -> float:
    """Map pct (0–1) to a timestamp; optionally skip the opening lead-in of the scene."""
    start = float(scene["start"])
    dur = float(scene["duration"])
    if lead_skip_pct > 0:
        usable = dur * (1.0 - lead_skip_pct)
        return start + dur * lead_skip_pct + usable * pct
    return start + dur * pct


def extract_sample_frames(
    video_path: pathlib.Path,
    scenes: list[dict[str, Any]],
    output_dir: pathlib.Path,
    clip_id: str = "clip0",
    *,
    max_frames: int = MAX_FRAMES,
    samples_per_scene: int = 1,
    lead_skip_pct: float = 0.0,
) -> list[dict[str, Any]]:
    """Extract representative JPEG(s) per scene for Vision matching."""
    import ffmpeg as ffmpeg_lib

    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict[str, Any]] = []

    per_scene = max(1, samples_per_scene)
    scene_cap = max(1, max_frames // per_scene)
    indices = _sample_indices(len(scenes), scene_cap)
    if lead_skip_pct > 0:
        base = list(DUB_SAMPLE_PCTS)
        pcts = base[:per_scene] if per_scene <= len(base) else base + [base[-1]] * (per_scene - len(base))
    elif per_scene == 1:
        pcts = [0.3]
    else:
        pcts = [0.2, 0.55, 0.8][:per_scene]

    for i in indices:
        if len(frames) >= max_frames:
            break
        scene = scenes[i]
        for j, pct in enumerate(pcts):
            if len(frames) >= max_frames:
                break
            t = _sample_time_in_scene(scene, pct, lead_skip_pct=lead_skip_pct)
            frame_path = output_dir / f"{clip_id}_scene_{i:03d}_{j}.jpg"
            try:
                run_ffmpeg(
                    ffmpeg_lib.input(str(video_path), ss=t)
                    .output(str(frame_path), vframes=1, q=2)
                    .overwrite_output(),
                    label=f"extract_frame_{clip_id}_{i}_{j}",
                )
                frames.append({
                    "scene_idx": i,
                    "clip_id": clip_id,
                    "time": round(t, 2),
                    "scene_start": scene["start"],
                    "scene_end": scene["end"],
                    "frame_path": str(frame_path),
                })
            except Exception as exc:
                log.warning("frame_extract_failed", scene_idx=i, error=str(exc))

    return frames


def _clip_edge_times(
    duration: float,
    *,
    edge_offset_sec: float = DUB_EDGE_OFFSET_SEC,
    min_gap_sec: float = 2.0,
) -> list[tuple[str, float]]:
    """Return (edge_label, timestamp) pairs for clip opening/closing samples."""
    if duration <= 0:
        return []
    offset = max(0.0, float(edge_offset_sec))
    opening = min(offset, max(0.5, duration - 0.5))
    closing = min(max(duration - 0.5, 0.0), max(opening + min_gap_sec, duration - offset))
    if closing <= opening + min_gap_sec:
        if duration <= min_gap_sec + 1.0:
            return [("opening", round(duration * 0.1, 2))]
        opening = round(duration * 0.1, 2)
        closing = round(duration * 0.9, 2)
    return [("opening", round(opening, 2)), ("closing", round(closing, 2))]


def extract_edge_frames(
    video_path: pathlib.Path,
    output_dir: pathlib.Path,
    clip_id: str = "clip0",
    *,
    edge_offset_sec: float = DUB_EDGE_OFFSET_SEC,
) -> list[dict[str, Any]]:
    """Extract opening/closing JPEGs — extra samples beyond scene-based frames."""
    import ffmpeg as ffmpeg_lib

    from packages.video.ffmpeg_bin import media_duration

    output_dir.mkdir(parents=True, exist_ok=True)
    dur = media_duration(video_path)
    frames: list[dict[str, Any]] = []

    for edge, t in _clip_edge_times(dur, edge_offset_sec=edge_offset_sec):
        frame_path = output_dir / f"{clip_id}_edge_{edge}.jpg"
        try:
            run_ffmpeg(
                ffmpeg_lib.input(str(video_path), ss=t)
                .output(str(frame_path), vframes=1, q=2)
                .overwrite_output(),
                label=f"extract_edge_{clip_id}_{edge}",
            )
            frames.append({
                "scene_idx": -1,
                "clip_id": clip_id,
                "time": round(t, 2),
                "scene_start": 0.0,
                "scene_end": round(dur, 2),
                "frame_path": str(frame_path),
                "edge": edge,
            })
        except Exception as exc:
            log.warning("edge_frame_extract_failed", clip_id=clip_id, edge=edge, error=str(exc))

    return frames


def format_frame_descriptor(frame: dict[str, Any]) -> str:
    """Human-readable timestamp line for Claude (scene sample or clip edge)."""
    clip_id = frame["clip_id"]
    t = float(frame["time"])
    edge = frame.get("edge")
    if edge == "opening":
        return f"[{clip_id} clip opening at {t:.1f}s]"
    if edge == "closing":
        return f"[{clip_id} clip closing at {t:.1f}s]"
    if edge == "hard_cut":
        return f"[{clip_id} hard cut at {t:.1f}s]"
    return (
        f"[{clip_id} scene {frame['scene_idx']} at {t:.1f}s "
        f"(source {float(frame['scene_start']):.1f}–{float(frame['scene_end']):.1f}s)]"
    )


def build_vision_content(frames: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Build LiteLLM image_url blocks and payload stats (single disk read per frame)."""
    content: list[dict[str, Any]] = []
    jpeg_bytes = 0
    base64_chars = 0
    missing = 0
    timestamps: list[float] = []
    jpeg_kb_per_frame: list[int] = []

    for frame in frames:
        path = pathlib.Path(str(frame.get("frame_path") or ""))
        if not path.exists():
            missing += 1
            log.warning("vision_frame_missing", path=str(path), time=frame.get("time"))
            continue
        raw = path.read_bytes()
        b64 = base64.b64encode(raw).decode()
        jpeg_bytes += len(raw)
        base64_chars += len(b64)
        timestamps.append(float(frame["time"]))
        jpeg_kb_per_frame.append(len(raw) // 1024)
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    stats: dict[str, Any] = {
        "requested_frames": len(frames),
        "image_blocks": len(content),
        "missing_files": missing,
        "jpeg_bytes": jpeg_bytes,
        "jpeg_kb": round(jpeg_bytes / 1024),
        "base64_chars": base64_chars,
        "base64_kb": round(base64_chars / 1024),
        "timestamps": timestamps,
        "jpeg_kb_per_frame": jpeg_kb_per_frame,
    }
    return content, stats


def frames_to_vision_content(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert frame dicts to LiteLLM image_url content blocks (base64 JPEG)."""
    content, _stats = build_vision_content(frames)
    return content


def _sample_indices(total: int, max_count: int) -> list[int]:
    """Return evenly spaced indices from [0, total) with at most max_count items."""
    if total <= max_count:
        return list(range(total))
    step = total / max_count
    return [int(i * step) for i in range(max_count)]
