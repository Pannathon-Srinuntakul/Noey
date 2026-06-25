"""Scene detection and frame extraction for dub_first mode."""

from __future__ import annotations

import base64
import pathlib
from typing import Any

from packages.core.logging import get_logger
from packages.video.ffmpeg_bin import run_ffmpeg

log = get_logger(__name__)

MAX_FRAMES = 15  # cap Claude Vision payload (talking_head)
DUB_MAX_FRAMES = 30  # dub_first: more angles → denser montage options


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


def extract_sample_frames(
    video_path: pathlib.Path,
    scenes: list[dict[str, Any]],
    output_dir: pathlib.Path,
    clip_id: str = "clip0",
    *,
    max_frames: int = MAX_FRAMES,
    samples_per_scene: int = 1,
) -> list[dict[str, Any]]:
    """Extract representative JPEG(s) per scene for Vision matching."""
    import ffmpeg as ffmpeg_lib

    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict[str, Any]] = []

    per_scene = max(1, samples_per_scene)
    scene_cap = max(1, max_frames // per_scene)
    indices = _sample_indices(len(scenes), scene_cap)
    pcts = [0.3] if per_scene == 1 else [0.2, 0.55, 0.8][:per_scene]

    for i in indices:
        if len(frames) >= max_frames:
            break
        scene = scenes[i]
        for j, pct in enumerate(pcts):
            if len(frames) >= max_frames:
                break
            t = scene["start"] + scene["duration"] * pct
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


def frames_to_vision_content(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert frame dicts to LiteLLM image_url content blocks (base64 JPEG)."""
    content: list[dict[str, Any]] = []
    for frame in frames:
        path = pathlib.Path(frame["frame_path"])
        if not path.exists():
            continue
        b64 = base64.b64encode(path.read_bytes()).decode()
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    return content


def _sample_indices(total: int, max_count: int) -> list[int]:
    """Return evenly spaced indices from [0, total) with at most max_count items."""
    if total <= max_count:
        return list(range(total))
    step = total / max_count
    return [int(i * step) for i in range(max_count)]
