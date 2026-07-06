"""One-off smoke test: Files API vs base64 vision latency. Run from backend/."""

from __future__ import annotations

import asyncio
import json
import pathlib
import time

from packages.llm.config import sync_llm_env, vision_call_kwargs
from packages.llm.files import delete_message_files
from packages.llm.gateway import acompletion
from packages.video.scene import build_vision_content, build_vision_content_uploaded

FRAMES_DIR = pathlib.Path("data/video_outputs/61278287-fe54-4213-ba11-dfc64a59b147/frames")
KEY = [FRAMES_DIR / f"key_0_{i}.jpg" for i in range(3)]
CLIP = sorted((FRAMES_DIR / "clip0").glob("*.jpg"))

SYSTEM = (
    'You are a video editor. Return ONLY JSON: {"ok": true, "frame_count": N} '
    "where N is how many images you received."
)


async def run_case(
    label: str,
    frames: list[dict[str, object]],
    *,
    use_files: bool,
    timeout: int = 180,
) -> None:
    sync_llm_env()
    import litellm

    litellm.suppress_debug_info = True
    uploaded_ids: list[str] = []
    t0 = time.monotonic()
    try:
        if use_files:
            blocks, stats, uploaded_ids = await build_vision_content_uploaded(frames)
            transport = stats.get("transport")
            jpeg_kb = stats.get("jpeg_kb")
        else:
            blocks, stats = build_vision_content(frames)
            transport = "base64"
            jpeg_kb = stats.get("jpeg_kb")
        upload_ms = round((time.monotonic() - t0) * 1000)
        user: list[dict[str, object]] = [
            {"type": "text", "text": f"Test {label}: count the images and return JSON only."},
            *blocks,
            {"type": "text", "text": "<reminder>JSON only</reminder>"},
        ]
        vx = vision_call_kwargs()
        vx["timeout"] = timeout
        t1 = time.monotonic()
        resp = await acompletion([{"role": "user", "content": user}], system=SYSTEM, **vx)
        api_ms = round((time.monotonic() - t1) * 1000)
        raw = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        inp = getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", None)
        out = getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", None)
        print(
            json.dumps(
                {
                    "case": label,
                    "transport": transport,
                    "frames": len(blocks),
                    "jpeg_kb": jpeg_kb,
                    "upload_ms": upload_ms,
                    "api_ms": api_ms,
                    "input_tokens": inp,
                    "output_tokens": out,
                    "preview": raw[:120].replace("\n", " "),
                },
                ensure_ascii=False,
            )
        )
    except Exception as exc:
        elapsed = round((time.monotonic() - t0) * 1000)
        print(
            json.dumps(
                {
                    "case": label,
                    "error": type(exc).__name__,
                    "msg": str(exc)[:300],
                    "elapsed_ms": elapsed,
                }
            )
        )
    finally:
        if uploaded_ids:
            await delete_message_files(uploaded_ids)


def _mk(paths: list[pathlib.Path]) -> list[dict[str, object]]:
    return [{"frame_path": str(p), "time": float(i)} for i, p in enumerate(paths)]


async def run_real_scene_match(*, effort: str | None = "medium", timeout: int = 300) -> None:
    import json as _json

    from packages.video.scene import format_frame_descriptor
    from services.worker.tasks import _EDIT_SCRIPT_SYSTEM

    script_path = pathlib.Path(
        "data/video_outputs/61278287-fe54-4213-ba11-dfc64a59b147/script_plan.json"
    )
    script_scenes = _json.loads(script_path.read_text(encoding="utf-8"))["scenes"]
    clip_frames = sorted((FRAMES_DIR / "clip0").glob("*.jpg"))
    # Rebuild minimal frame dicts like extract_dub_budget_frames would
    frames: list[dict[str, object]] = []
    for i, p in enumerate(clip_frames[:20]):
        frames.append(
            {
                "frame_path": str(p),
                "time": 5.0 + i * 30.0,
                "clip_id": "clip0",
                "scene_idx": i,
                "scene_start": 5.0 + i * 30.0,
                "scene_end": 5.0 + (i + 1) * 30.0,
            }
        )
    # opening + closing placeholders
    for edge, t in (("opening", 5.0), ("closing", 595.0)):
        ep = FRAMES_DIR / "clip0" / f"clip0_edge_{edge}.jpg"
        if not ep.exists():
            ep = clip_frames[0] if edge == "opening" else clip_frames[-1]
        frames.insert(0 if edge == "opening" else len(frames), {
            "frame_path": str(ep),
            "time": t,
            "clip_id": "clip0",
            "edge": edge,
        })

    sync_llm_env()
    import litellm

    litellm.suppress_debug_info = True
    uploaded_ids: list[str] = []
    t0 = time.monotonic()
    try:
        blocks, stats, uploaded_ids = await build_vision_content_uploaded(frames[:22])
        frame_descs = "\n".join(format_frame_descriptor(f) for f in frames[:22])
        plan_total = sum(int(s.get("estimated_sec") or 0) for s in script_scenes)
        script_plan_xml = (
            f"<script_plan>\n{_json.dumps(script_scenes, ensure_ascii=False)}\n</script_plan>"
        )
        user: list[dict[str, object]] = [
            {
                "type": "text",
                "text": (
                    f"{script_plan_xml}\n\n"
                    f"<frame_timestamps>\n{frame_descs}\n</frame_timestamps>\n\n"
                    "<instruction>Sample frames follow in order. Return Edit Script JSON only.</instruction>"
                ),
            },
            *blocks,
            {"type": "text", "text": "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"},
        ]
        vx = vision_call_kwargs()
        vx["timeout"] = timeout
        if effort:
            vx["reasoning_effort"] = effort
        else:
            vx.pop("reasoning_effort", None)
        t1 = time.monotonic()
        resp = await acompletion(
            [{"role": "user", "content": user}],
            system=_EDIT_SCRIPT_SYSTEM,
            **vx,
        )
        api_ms = round((time.monotonic() - t1) * 1000)
        raw = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        inp = getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", None)
        out = getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", None)
        print(
            _json.dumps(
                {
                    "case": f"real_scene_match_effort_{effort or 'none'}",
                    "frames": len(blocks),
                    "jpeg_kb": stats.get("jpeg_kb"),
                    "system_chars": len(_EDIT_SCRIPT_SYSTEM),
                    "user_text_chars": len(user[0]["text"]) + len(user[-1]["text"]),
                    "api_ms": api_ms,
                    "input_tokens": inp,
                    "output_tokens": out,
                    "preview": raw[:150].replace("\n", " "),
                },
                ensure_ascii=False,
            )
        )
    except Exception as exc:
        elapsed = round((time.monotonic() - t0) * 1000)
        print(
            _json.dumps(
                {
                    "case": f"real_scene_match_effort_{effort or 'none'}",
                    "error": type(exc).__name__,
                    "msg": str(exc)[:300],
                    "elapsed_ms": elapsed,
                }
            )
        )
    finally:
        if uploaded_ids:
            await delete_message_files(uploaded_ids)


async def main() -> None:
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "real":
        effort = sys.argv[2] if len(sys.argv) > 2 else "medium"
        await run_real_scene_match(effort=effort if effort != "none" else None)
        return
    print("=== vision smoke tests ===")
    await run_case("files_3", _mk(KEY), use_files=True, timeout=120)
    await run_case("files_5", _mk(CLIP[:5]), use_files=True, timeout=180)
    await run_case("files_22", _mk(CLIP[:22]), use_files=True, timeout=300)
    await run_case("base64_3", _mk(KEY), use_files=False, timeout=120)


if __name__ == "__main__":
    asyncio.run(main())
