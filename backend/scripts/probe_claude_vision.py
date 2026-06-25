"""Quick Claude API latency probe (text + vision). Run from backend/."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


async def main() -> None:
    from packages.llm.config import vision_call_kwargs
    from packages.llm.gateway import acompletion
    from packages.video.scene import build_vision_content

    vx = vision_call_kwargs()
    print("model", vx.get("model"), "effort", vx.get("reasoning_effort"))

    t0 = time.monotonic()
    try:
        r = await acompletion(
            [{"role": "user", "content": "Reply with exactly: ok"}],
            **vx,
        )
        txt = (r.choices[0].message.content or "")[:80]
        print(f"TEXT_OK elapsed={round(time.monotonic() - t0, 1)}s reply={txt!r}")
    except Exception as exc:
        print(f"TEXT_FAIL elapsed={round(time.monotonic() - t0, 1)}s error={type(exc).__name__}: {exc!s:.200}")

    frame_dir = BACKEND / "data/video_outputs/8df41c1b-85d4-4914-a9d4-6cff3e948ab5/frames/clip0"
    jpgs = sorted(frame_dir.glob("*.jpg")) if frame_dir.exists() else []
    if not jpgs:
        print("NO_JPEGS — skip vision tests")
        return

    one = [{"frame_path": str(jpgs[0]), "time": 5.0, "clip_id": "clip0", "scene_idx": 0}]
    content, stats = build_vision_content(one)
    t0 = time.monotonic()
    try:
        r = await acompletion(
            [{"role": "user", "content": [
                {"type": "text", "text": "Describe this frame in 5 words."},
                *content,
            ]}],
            **vx,
        )
        txt = (r.choices[0].message.content or "")[:80]
        print(
            f"VISION_1_OK elapsed={round(time.monotonic() - t0, 1)}s "
            f"jpeg_kb={stats['jpeg_kb']} reply={txt!r}"
        )
    except Exception as exc:
        print(f"VISION_1_FAIL elapsed={round(time.monotonic() - t0, 1)}s error={type(exc).__name__}: {exc!s:.300}")

    frames = [
        {"frame_path": str(p), "time": float(i * 5), "clip_id": "clip0", "scene_idx": i}
        for i, p in enumerate(jpgs[:8])
    ]
    content, stats = build_vision_content(frames)
    print(
        f"VISION_8 payload blocks={stats['image_blocks']} "
        f"jpeg_kb={stats['jpeg_kb']} base64_kb={stats['base64_kb']}"
    )
    t0 = time.monotonic()
    try:
        r = await acompletion(
            [{"role": "user", "content": [
                {"type": "text", "text": "One-word description per frame as JSON array."},
                *content,
            ]}],
            **vx,
        )
        txt = (r.choices[0].message.content or "")[:120]
        print(f"VISION_8_OK elapsed={round(time.monotonic() - t0, 1)}s reply={txt!r}")
    except Exception as exc:
        print(f"VISION_8_FAIL elapsed={round(time.monotonic() - t0, 1)}s error={type(exc).__name__}: {exc!s:.400}")


if __name__ == "__main__":
    asyncio.run(main())
