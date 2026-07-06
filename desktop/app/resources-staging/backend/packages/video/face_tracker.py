"""OpenCV Haar-cascade face detection for speaker-focus crop.

Samples frames from a video clip, detects faces, computes a stable
median bounding box, and returns the crop parameters for ffmpeg.
"""

from __future__ import annotations

import pathlib
import statistics
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)


def detect_face_bbox(frame_path: pathlib.Path) -> dict[str, float] | None:
    """Detect dominant face in a JPEG frame using OpenCV Haar cascades.

    Returns {"cx": float, "cy": float, "w": float, "h": float} normalized to [0,1],
    or None if no face detected.
    """
    import cv2

    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    img = cv2.imread(str(frame_path))
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ih, iw = img.shape[:2]

    faces = cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(60, 60),
    )
    if len(faces) == 0:
        return None

    # Pick the largest face
    fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
    return {
        "cx": (fx + fw / 2) / iw,
        "cy": (fy + fh / 2) / ih,
        "w": fw / iw,
        "h": fh / ih,
    }


def track_faces_in_clip(
    video_path: pathlib.Path,
    sample_every_n: int = 30,
) -> list[dict[str, Any]]:
    """Sample every N frames from the video clip and detect faces.

    Returns list of {"frame_idx": int, "time_sec": float, "bbox": dict | None}.
    """
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        log.warning("face_tracker_open_failed", path=str(video_path))
        return []

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    results: list[dict[str, Any]] = []
    frame_idx = 0

    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample_every_n == 0:
            ih, iw = frame.shape[:2]
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
            bbox = None
            if len(faces) > 0:
                fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
                bbox = {"cx": (fx + fw / 2) / iw, "cy": (fy + fh / 2) / ih, "w": fw / iw, "h": fh / ih}
            results.append({"frame_idx": frame_idx, "time_sec": round(frame_idx / fps, 3), "bbox": bbox})
        frame_idx += 1

    cap.release()
    log.info("face_tracked", path=str(video_path), samples=len(results), faces=sum(1 for r in results if r["bbox"]))
    return results


def median_face_crop(
    face_results: list[dict[str, Any]],
    vid_w: int,
    vid_h: int,
    target_aspect: float = 9 / 16,
) -> dict[str, int] | None:
    """Compute a stable crop box from face track results.

    Returns {"x": int, "y": int, "w": int, "h": int} in pixels,
    or None if fewer than 2 faces were detected.
    """
    bboxes = [r["bbox"] for r in face_results if r["bbox"] is not None]
    if len(bboxes) < 2:
        return None

    cx_med = statistics.median(b["cx"] for b in bboxes)
    cy_med = statistics.median(b["cy"] for b in bboxes)

    # Crop dimensions: maintain target_aspect, leave room around face
    crop_h = vid_h
    crop_w = round(crop_h * target_aspect)
    if crop_w > vid_w:
        crop_w = vid_w
        crop_h = round(crop_w / target_aspect)

    # Center crop on median face cx
    cx_px = round(cx_med * vid_w)
    cy_px = round(cy_med * vid_h)

    x = max(0, min(cx_px - crop_w // 2, vid_w - crop_w))
    # Bias crop upward: face center should be ~35% from top (TikTok talking-head style)
    y = max(0, min(cy_px - round(crop_h * 0.35), vid_h - crop_h))

    return {"x": x, "y": y, "w": crop_w, "h": crop_h}


def build_ffmpeg_crop_filter(crop: dict[str, int]) -> str:
    """Return ffmpeg crop filter string: crop=w:h:x:y"""
    return f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}"
