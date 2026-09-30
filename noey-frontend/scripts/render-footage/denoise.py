"""Cleans the path tracer's grain out of the rendered frames, before encode.mjs.

At the sample counts a laptop can afford (64 per pixel, ~16 s a frame), the
renders carry heavy per-frame noise, worst inside the glass and the serum.
Encoded as it is, that noise looks like a cheap render and costs ~8 Mbit/s.

Every shot is one slow camera move, so the same surface is seen in the frames
around each frame: each neighbour within RADIUS frames is aligned onto the
frame with dense optical flow (computed on blurred copies, so the grain does
not steer it), and the pixel becomes the mean of the aligned samples closest
to their median — fireflies and any sample the flow got wrong fall out. A
light non-local-means pass polishes what is left. The label's small print
stays sharp because it is aligned, not blurred.

Usage (Python with opencv-python and numpy; backend/.venv has both):
    python denoise.py --frames DIR --out DIR [shot ...]
Then: node encode.mjs --frames <the --out DIR>
"""

from __future__ import annotations

import argparse
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

RADIUS = 6  # neighbours on each side
KEEP = 0.6  # share of the aligned samples, closest to the median, that are averaged
POLISH_H = 3  # non-local means strength after the temporal pass

_local = threading.local()


def flow_engine() -> cv2.DISOpticalFlow:
    # DIS is not thread-safe: one per worker thread.
    if not hasattr(_local, "dis"):
        _local.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    return _local.dis


def guide(frame: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(cv2.GaussianBlur(frame, (0, 0), 1.6), cv2.COLOR_BGR2GRAY)


def clean(frames: list[np.ndarray], guides: list[np.ndarray], n: int) -> np.ndarray:
    current = frames[n]
    h, w = current.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    samples = []
    for k in range(max(0, n - RADIUS), min(len(frames), n + RADIUS + 1)):
        if k == n:
            samples.append(current.astype(np.float32))
            continue
        # flow[y, x] = where pixel (x, y) of frame n is found in frame k
        flow = flow_engine().calc(guides[n], guides[k], None)
        aligned = cv2.remap(frames[k], grid_x + flow[..., 0], grid_y + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        samples.append(aligned.astype(np.float32))
    stack = np.stack(samples)
    median = np.median(stack, axis=0)
    distance = np.abs(stack - median[None]).sum(axis=3, keepdims=True)
    keep = distance <= np.quantile(distance, KEEP, axis=0, keepdims=True)
    mean = (stack * keep).sum(axis=0) / np.maximum(keep.sum(axis=0), 1)
    merged = np.clip(mean + 0.5, 0, 255).astype(np.uint8)
    return cv2.fastNlMeansDenoisingColored(merged, None, POLISH_H, POLISH_H, 5, 15)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("shots", nargs="*")
    args = parser.parse_args()
    shots = args.shots or sorted(d for d in os.listdir(args.frames) if os.path.isdir(os.path.join(args.frames, d)))
    for shot in shots:
        source = os.path.join(args.frames, shot)
        names = sorted(f for f in os.listdir(source) if f.endswith(".png"))
        frames = [cv2.imread(os.path.join(source, name)) for name in names]
        guides = [guide(frame) for frame in frames]
        target = os.path.join(args.out, shot)
        os.makedirs(target, exist_ok=True)

        def work(n: int) -> None:
            cv2.imwrite(os.path.join(target, names[n]), clean(frames, guides, n))

        with ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
            list(pool.map(work, range(len(frames))))
        print(f"{shot}: {len(frames)} frames", flush=True)


if __name__ == "__main__":
    main()
