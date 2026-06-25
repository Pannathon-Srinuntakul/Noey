"""Measure dub_first scene-match prompt size vs short vision probe."""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from packages.video.scene import build_vision_content, format_frame_descriptor
from services.worker.tasks import _EDIT_SCRIPT_SYSTEM


def kb(n: int | float) -> float:
    return n / 1024


def main() -> None:
    proj = BACKEND / "data/video_outputs/a7dc4eb9-4780-4324-87e3-1f9780edc787"
    script = json.loads((proj / "script_plan.json").read_text(encoding="utf-8"))
    jpgs = sorted((proj / "frames/clip0").glob("*.jpg"))
    frames = [
        {
            "frame_path": str(p),
            "time": float(i * 60),
            "clip_id": "clip0",
            "scene_idx": i,
            "scene_start": 0,
            "scene_end": 600,
        }
        for i, p in enumerate(jpgs)
    ]
    _, stats10 = build_vision_content(frames)

    proj41 = BACKEND / "data/video_outputs/8df41c1b-85d4-4914-a9d4-6cff3e948ab5"
    jpgs14 = sorted((proj41 / "frames/clip0").glob("*.jpg")) if (proj41 / "frames/clip0").exists() else jpgs
    frames14 = [
        {
            "frame_path": str(p),
            "time": float(i * 3),
            "clip_id": "clip0",
            "scene_idx": i,
            "scene_start": 0,
            "scene_end": 41.4,
        }
        for i, p in enumerate(jpgs14)
    ]
    _, stats14 = build_vision_content(frames14)

    script_scenes = script.get("scenes", script)
    script_xml = f"<script_plan>\n{json.dumps(script_scenes, ensure_ascii=False)}\n</script_plan>"
    descs = "\n".join(format_frame_descriptor(f) for f in frames)
    user_text = (
        f"{script_xml}\n\n<frame_timestamps>\n{descs}\n</frame_timestamps>\n\n"
        "<instruction>Sample frames follow in order. Budget slots are evenly spaced across clip duration; "
        "hard-cut boost frames (when present) mark PySceneDetect shot boundaries; "
        "clip opening/closing edge samples are included as extra options (use only when they fit the script). "
        "Match voiceover lines to creator-ready or product-ready moments (product close-ups and full-frame reveals count even without a visible face). "
        "Each sample timestamp may appear once only; order cuts forward through the clip timeline. "
        "Set matchedFrameTime to the frame timestamp you chose; keep sourceIn within ±0.35s of it. "
        "For product/OOTD/demo lines: use 3–6 angle changes per line (1.5–3.5s each) from DISTINCT timestamps — "
        "avoid one long 5s+ hold on a single angle when other frames are available.</instruction>"
    )
    reminder = "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"

    sys_c = len(_EDIT_SCRIPT_SYSTEM)
    usr_c = len(user_text) + len(reminder)
    short = "One-word description per frame as JSON array."

    print("=== TEXT ===")
    print(f"system _EDIT_SCRIPT_SYSTEM: {kb(sys_c):.1f} KB ({sys_c:,} chars)")
    print(f"user message text:          {kb(usr_c):.1f} KB ({usr_c:,} chars)")
    print(f"  script_plan JSON:         {kb(len(script_xml)):.1f} KB")
    print(f"  frame_descriptors:        {kb(len(descs)):.1f} KB ({len(frames)} lines)")
    print(f"  instruction + reminder:   {kb(len(user_text) - len(script_xml) - len(descs) - 2 + len(reminder)):.1f} KB")
    print(f"TEXT TOTAL:                 {kb(sys_c + usr_c):.1f} KB")
    print()
    print("=== IMAGES (base64, not in text count) ===")
    print(f"10 frames (a7dc4eb9):       {stats10['base64_kb']} KB")
    print(f"14 frames (8df41c1b):       {stats14['base64_kb']} KB")
    print()
    print("=== GRAND TOTAL (text + images) ===")
    print(f"dub match ~10 frames:       {kb(sys_c + usr_c) + stats10['base64_kb']:.0f} KB")
    print(f"dub match ~14 frames:       {kb(sys_c + usr_c) + stats14['base64_kb']:.0f} KB")
    print()
    print("=== vs probe (8 frames, short prompt) ===")
    print(f"short prompt:               {kb(len(short)):.2f} KB")
    print(f"8 frames base64 (probe):    ~985 KB")
    print(f"probe total:                ~986 KB")
    print(f"text ratio dub/short:       {(sys_c + usr_c) / len(short):.0f}x longer")


if __name__ == "__main__":
    main()
