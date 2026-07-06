"""Smoke test: stream one image through acompletion_stream_thinking and print thinking chunks.

Run from backend/:
    python scripts/probe_stream_thinking.py [path/to/frame.jpg]

If no JPEG given, uses a solid-colour synthetic image (no real frame needed).
Prints each thinking chunk as it arrives so you can verify the attribute name is correct.
"""

from __future__ import annotations

import asyncio
import io
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _make_synthetic_jpeg() -> Path:
    """Create a tiny 64x64 red JPEG in /tmp for testing when no real frame exists."""
    try:
        from PIL import Image
        img = Image.new("RGB", (64, 64), color=(200, 50, 50))
        out = Path(BACKEND) / "data" / "_probe_frame.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        img.save(out, "JPEG", quality=50)
        return out
    except ImportError:
        # PIL not available — write raw minimal JPEG bytes
        import base64
        # Minimal 1x1 red JPEG (hardcoded bytes)
        RED_1X1_JPEG_B64 = (
            "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U"
            "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN"
            "DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
            "MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAHhAA"
            "AgIDAQEBAAAAAAAAAAAAAQIDBAUREiH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA"
            "AAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKWiqoqtLKxtaz1bWvDV9QAAAABJRU5ErkJggg=="
        )
        out = Path(BACKEND) / "data" / "_probe_frame.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(RED_1X1_JPEG_B64))
        return out


async def main() -> None:
    # ── resolve frame ──────────────────────────────────────────────────────────
    if len(sys.argv) > 1:
        frame_path = Path(sys.argv[1])
        if not frame_path.exists():
            print(f"ERROR: file not found: {frame_path}")
            sys.exit(1)
        print(f"Using frame: {frame_path}")
    else:
        frame_path = _make_synthetic_jpeg()
        print(f"No frame given — using synthetic JPEG: {frame_path}")

    # ── build vision content (Files API upload) ───────────────────────────────
    from packages.video.scene import build_vision_content_uploaded

    frames = [{"frame_path": str(frame_path), "time": 5.0, "clip_id": "clip0", "scene_idx": 0}]
    print("Uploading frame via Files API…")
    t_upload = time.monotonic()
    vision_content, stats, uploaded_ids = await build_vision_content_uploaded(frames)
    upload_ms = round((time.monotonic() - t_upload) * 1000)
    print(f"Upload done: {upload_ms}ms  transport={stats.get('transport')}  "
          f"image_blocks={stats['image_blocks']}  message_payload_kb={stats.get('message_payload_kb', 0):.1f}KB")

    # ── build messages ─────────────────────────────────────────────────────────
    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": (
                "You are a TikTok affiliate video editor. Analyze this frame carefully.\n\n"
                "<script_plan>\n"
                "[{\"order\":1,\"voiceover_line\":\"วันนี้มารีวิวครีมตัวนี้ที่ใช้มา 2 สัปดาห์\",\"estimated_sec\":5,\"visual_hint\":\"product reveal\"},"
                "{\"order\":2,\"voiceover_line\":\"เนื้อครีมบางเบา ซึมไว ไม่เหนียว\",\"estimated_sec\":6,\"visual_hint\":\"multi-angle demo\"},"
                "{\"order\":3,\"voiceover_line\":\"ราคาดีมาก คุ้มค่ามาก\",\"estimated_sec\":4,\"visual_hint\":\"CTA hook\"}]\n"
                "</script_plan>\n\n"
                "<frame_timestamps>\n"
                "clip0 | t=5.20s | scene=0 | opening\n"
                "</frame_timestamps>\n\n"
                "<instruction>Script plan targets ~15s total. "
                "Use ONLY hero moments. HARD REJECT: undressing, underwear, putting on pants. "
                "Return the Edit Script JSON.</instruction>"
            )},
            *vision_content,
        ],
    }]

    # ── intercept litellm.acompletion to inspect raw delta attributes ─────────
    import litellm as _litellm

    chunk_count = 0
    first_thinking_attr: str | None = None
    _orig = _litellm.acompletion

    class _StreamWrapper:
        """Wraps the real async stream to intercept and log delta attrs."""
        def __init__(self, real_iter: object) -> None:
            self._real = real_iter
            self._n = 0

        def __aiter__(self) -> "_StreamWrapper":
            return self

        async def __anext__(self) -> object:
            nonlocal chunk_count, first_thinking_attr
            chunk = await self._real.__anext__()  # type: ignore[attr-defined]
            chunk_count += 1
            self._n += 1
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is not None and self._n <= 8:
                # Pydantic model — use model_dump(), fallback to vars()
                try:
                    raw = delta.model_dump()
                except AttributeError:
                    raw = vars(delta) if hasattr(delta, "__dict__") else {}
                attrs = {k: v for k, v in raw.items() if v not in (None, "", [], {})}
                if attrs:
                    print(f"[chunk {self._n}] delta: {attrs}")
                if first_thinking_attr is None:
                    for candidate in ("thinking", "thinking_blocks", "provider_specific_fields"):
                        val = raw.get(candidate)
                        if val:
                            first_thinking_attr = candidate
                            print(f"[ATTR_FOUND] delta.{candidate} = {str(val)[:80]!r}")
                            break
            return chunk

    async def _intercepted(**kwargs: object) -> object:
        real_stream = await _orig(**kwargs)
        return _StreamWrapper(real_stream)

    _litellm.acompletion = _intercepted  # apply patch

    from packages.llm.config import vision_call_kwargs
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.llm.files import delete_message_files

    vx = vision_call_kwargs()
    print(f"\nModel: {vx.get('model')}  effort: {vx.get('reasoning_effort')}")
    print("-" * 60)
    print("Streaming... (first 5 chunks dumped)\n")

    t0 = time.monotonic()
    try:
        resp = await acompletion_stream_thinking(
            messages,
            project_uid="probe_test",
            **vx,
        )
        elapsed = round(time.monotonic() - t0, 1)
        content = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        input_tok = getattr(usage, "prompt_tokens", "?")
        output_tok = getattr(usage, "completion_tokens", "?")

        print("\n" + "-" * 60)
        print(f"DONE  elapsed={elapsed}s  total_chunks={chunk_count}")
        print(f"Usage: input={input_tok}  output={output_tok}")
        print(f"Reply: {content[:300]}")
        if first_thinking_attr is None:
            print("\nWARN: no thinking attr found — model skipped thinking (adaptive) or attr name unknown")
        else:
            print(f"\nOK: thinking arrived via delta.{first_thinking_attr}")
    except Exception as exc:
        print(f"\nFAIL elapsed={round(time.monotonic() - t0, 1)}s  {type(exc).__name__}: {exc!s:.400}")
    finally:
        _litellm.acompletion = _orig  # restore
        await delete_message_files(uploaded_ids)
        print("Files API cleanup done")


if __name__ == "__main__":
    asyncio.run(main())
