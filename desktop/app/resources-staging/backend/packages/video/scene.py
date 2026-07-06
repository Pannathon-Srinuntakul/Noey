"""Scene detection and frame extraction for dub_first mode."""

from __future__ import annotations

import asyncio
import base64
import math
import pathlib
import time
from typing import Any

from packages.core.logging import get_logger
from packages.video.ffmpeg_bin import run_ffmpeg

log = get_logger(__name__)

MAX_FRAMES = 15  # cap Claude Vision payload (talking_head)
# dub_first: evenly-spaced time slots scale with clip length (no early cap).
DUB_MAX_CLIP_SEC = 10 * 60  # upload + sampling ceiling (10 minutes)
DUB_UPLOAD_TOLERANCE_SEC = 5.0  # ffprobe/container slack for "10:00" exports
DUB_SCENE_INTERVAL_SEC = 15  # ~1 slot every 15s; capped by DUB_MAX_BUDGET_FRAMES
DUB_MAX_BUDGET_FRAMES = 30  # hard cap; frames distributed evenly when clip hits cap
DUB_SAMPLES_PER_SCENE = 1  # one JPEG per slot
# Skip early part of each slot — prep/hair-adjust usually happens at window start.
DUB_LEAD_SKIP_PCT = 0.25
DUB_SAMPLE_PCTS = (0.5,)  # single sample per slot, mid usable portion
# Extra clip-edge samples (added on top of budget slots, not counted in max_frames).
DUB_EDGE_OFFSET_SEC = 5.0  # opening at 5s; closing at duration − 5s


def dub_clip_exceeds_upload_limit(duration_sec: float) -> bool:
    """True when source clip is over the advertised upload cap (with small ffprobe slack)."""
    return float(duration_sec) > DUB_MAX_CLIP_SEC + DUB_UPLOAD_TOLERANCE_SEC


def dub_scene_cap(duration_sec: float) -> int:
    """How many evenly-spaced time slots to sample for Vision, from clip duration."""
    dur = min(max(float(duration_sec), 0.0), float(DUB_MAX_CLIP_SEC))
    if dur <= 0:
        return 0
    return min(max(1, math.ceil(dur / DUB_SCENE_INTERVAL_SEC)), DUB_MAX_BUDGET_FRAMES)


def dub_sample_frame_budget(
    duration_sec: float,
    *,
    samples_per_scene: int = DUB_SAMPLES_PER_SCENE,
) -> int:
    """Max budget JPEGs to extract (excludes opening/closing edge frames)."""
    return dub_scene_cap(duration_sec) * max(1, samples_per_scene)


def budget_sample_windows(duration_sec: float, slot_count: int | None = None) -> list[dict[str, Any]]:
    """Evenly divide clip duration into sampling windows (primary dub_first coverage)."""
    dur = min(max(float(duration_sec), 0.0), float(DUB_MAX_CLIP_SEC))
    count = dub_scene_cap(dur) if slot_count is None else max(1, int(slot_count))
    if dur <= 0:
        return []
    step = dur / count
    windows: list[dict[str, Any]] = []
    for i in range(count):
        start = i * step
        end = dur if i == count - 1 else (i + 1) * step
        windows.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
        })
    return windows


def extract_dub_budget_frames(
    video_path: pathlib.Path,
    output_dir: pathlib.Path,
    clip_id: str = "clip0",
    *,
    duration_sec: float | None = None,
    samples_per_scene: int = DUB_SAMPLES_PER_SCENE,
    lead_skip_pct: float = DUB_LEAD_SKIP_PCT,
) -> list[dict[str, Any]]:
    """Sample JPEGs for dub_first from duration-based budget slots (no PySceneDetect)."""
    from packages.video.ffmpeg_bin import media_duration

    dur = float(duration_sec) if duration_sec is not None else media_duration(video_path)
    slot_count = dub_scene_cap(dur)
    frame_budget = dub_sample_frame_budget(dur, samples_per_scene=samples_per_scene)
    windows = budget_sample_windows(dur, slot_count)
    frames = extract_sample_frames(
        video_path,
        windows,
        output_dir,
        clip_id=clip_id,
        max_frames=frame_budget,
        samples_per_scene=samples_per_scene,
        lead_skip_pct=lead_skip_pct,
    )
    log.info(
        "dub_budget_sampled",
        clip=clip_id,
        duration_sec=round(dur, 1),
        slots=slot_count,
        budget_frames=len(frames),
    )
    return frames


def _nearest_frame_gap_sec(existing_times: list[float], t: float) -> float:
    if not existing_times:
        return float("inf")
    return min(abs(t - et) for et in existing_times)


def extract_frames_at_timestamps(
    clip_videos: dict[str, pathlib.Path],
    requests: list[dict[str, Any]],
    output_dir: pathlib.Path,
    existing_frames: list[dict[str, Any]] | None = None,
    *,
    min_gap_sec: float = 2.5,
    max_requests: int = 6,
) -> list[dict[str, Any]]:
    """Extract extra JPEGs at Claude-requested timestamps (deduped vs existing samples)."""
    import ffmpeg as ffmpeg_lib

    from packages.video.ffmpeg_bin import media_duration

    output_dir.mkdir(parents=True, exist_ok=True)
    existing = existing_frames or []
    existing_times_by_clip: dict[str, list[float]] = {}
    for fr in existing:
        cid = str(fr.get("clip_id") or "clip0")
        existing_times_by_clip.setdefault(cid, []).append(float(fr["time"]))

    out: list[dict[str, Any]] = []
    seen_req: list[tuple[str, float]] = []

    for req in requests[:max_requests]:
        clip_id = str(req.get("sourceClip") or req.get("clip_id") or "clip0").strip()
        try:
            t = float(req.get("timeSec") if req.get("timeSec") is not None else req.get("time"))
        except (TypeError, ValueError):
            continue
        video_path = clip_videos.get(clip_id)
        if video_path is None or not video_path.exists():
            log.warning("frame_request_unknown_clip", clip_id=clip_id, time=t)
            continue
        dur = media_duration(video_path)
        t = round(min(max(t, 0.0), max(dur - 0.05, 0.0)), 2)
        if _nearest_frame_gap_sec(existing_times_by_clip.get(clip_id, []), t) < min_gap_sec:
            continue
        if any(abs(t - rt) < min_gap_sec and clip_id == rc for rc, rt in seen_req):
            continue
        seen_req.append((clip_id, t))
        tag = f"req_{len(seen_req):02d}"
        frame_path = output_dir / f"{clip_id}_{tag}_{int(t * 10)}.jpg"
        try:
            run_ffmpeg(
                ffmpeg_lib.input(str(video_path), ss=t)
                .output(str(frame_path), vframes=1, q=2)
                .overwrite_output(),
                label=f"extract_frame_request_{clip_id}_{tag}",
            )
            fr = {
                "scene_idx": -2,
                "clip_id": clip_id,
                "time": t,
                "scene_start": t,
                "scene_end": t,
                "frame_path": str(frame_path),
                "edge": "requested",
                "request_reason": str(req.get("reason") or ""),
            }
            out.append(fr)
            existing_times_by_clip.setdefault(clip_id, []).append(t)
        except Exception as exc:
            log.warning("frame_request_extract_failed", clip_id=clip_id, time=t, error=str(exc))

    log.info("dub_frame_requests_extracted", requested=len(requests), extracted=len(out))
    return out


def merge_frame_lists(
    primary: list[dict[str, Any]],
    extra: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Append extra frames, sorted by clip_id then time."""
    merged = [*primary, *extra]
    merged.sort(key=lambda f: (str(f.get("clip_id") or ""), float(f.get("time") or 0)))
    return merged


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
    if edge == "requested":
        reason = str(frame.get("request_reason") or "").strip()
        suffix = f" — {reason}" if reason else ""
        return f"[{clip_id} requested sample at {t:.1f}s{suffix}]"
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


async def build_vision_content_uploaded(
    frames: list[dict[str, Any]],
    *,
    max_parallel: int = 8,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """Upload JPEGs via Anthropic Files API; reference file_id in Messages (no base64 inline)."""
    from packages.llm.files import upload_message_file_path, vision_file_block

    t0 = time.monotonic()
    semaphore = asyncio.Semaphore(max(1, max_parallel))
    jpeg_bytes = 0
    missing = 0
    timestamps: list[float] = []
    jpeg_kb_per_frame: list[int] = []
    file_ids: list[str] = []
    content: list[dict[str, Any]] = []

    async def _upload_one(frame: dict[str, Any], order: int) -> tuple[int, str | None, int]:
        path = pathlib.Path(str(frame.get("frame_path") or ""))
        if not path.exists():
            log.warning("vision_frame_missing", path=str(path), time=frame.get("time"))
            return order, None, 0
        size = path.stat().st_size
        async with semaphore:
            fid = await upload_message_file_path(path)
        return order, fid, size

    pending = [
        _upload_one(frame, i)
        for i, frame in enumerate(frames)
    ]
    results = await asyncio.gather(*pending)

    for order, fid, size in sorted(results, key=lambda row: row[0]):
        frame = frames[order]
        if fid is None:
            missing += 1
            continue
        jpeg_bytes += size
        timestamps.append(float(frame["time"]))
        jpeg_kb_per_frame.append(size // 1024)
        file_ids.append(fid)
        content.append(vision_file_block(fid))

    upload_ms = round((time.monotonic() - t0) * 1000)
    ref_chars = sum(len(fid) for fid in file_ids)
    stats: dict[str, Any] = {
        "transport": "anthropic_files_api",
        "requested_frames": len(frames),
        "image_blocks": len(content),
        "missing_files": missing,
        "jpeg_bytes": jpeg_bytes,
        "jpeg_kb": round(jpeg_bytes / 1024),
        "file_ids": file_ids,
        "file_ref_chars": ref_chars,
        "message_payload_kb": round(ref_chars / 1024),
        "upload_ms": upload_ms,
        "timestamps": timestamps,
        "jpeg_kb_per_frame": jpeg_kb_per_frame,
        # legacy keys for callers that still read base64_kb
        "base64_chars": 0,
        "base64_kb": 0,
    }
    log.info(
        "vision_files_uploaded",
        frames=len(content),
        missing=missing,
        jpeg_kb=stats["jpeg_kb"],
        upload_ms=upload_ms,
        message_payload_kb=stats["message_payload_kb"],
    )
    return content, stats, file_ids


def _sample_indices(total: int, max_count: int) -> list[int]:
    """Return evenly spaced indices from [0, total) with at most max_count items."""
    if total <= max_count:
        return list(range(total))
    step = total / max_count
    return [int(i * step) for i in range(max_count)]
