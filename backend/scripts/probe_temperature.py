"""Does gemini-3.x accept `temperature` alongside thinking, and does it help?

The dub edit call has always run at Gemini's default temperature (1.0) with no
seed: two runs of the SAME clip with the SAME prompt produced 11 cuts / 31.0s
and 8 cuts / 17.9s (6 of 14 segments invented timestamps past the end of the
footage and were dropped). Before wiring a temperature setting through, two
things need checking on the real API:

  1. accepted at all — LiteLLM may drop it, or Gemini may reject it when
     thinking is on
  2. worth having — same prompt, N samples at each temperature, measured on
     the failure that actually bit us: timestamps outside the clip

Text-only, ~200 output tokens per sample, so a full sweep costs well under a
baht. Run from backend/:  python scripts/probe_temperature.py
"""

from __future__ import annotations

import asyncio
import json
import sys

sys.path.insert(0, ".")

from packages.core.settings import get_settings  # noqa: E402
from packages.llm.config import call_kwargs, sync_llm_env  # noqa: E402

SAMPLES = 4
TEMPS: list[float | None] = [None, 0.0, 0.2]

# A miniature of the real task: pick moments out of a fixed timeline and stay
# inside it. No video upload — the failure we are probing is the model losing
# track of a stated bound, which reproduces on text alone.
SYSTEM = """You are a video editor. Return ONLY JSON: {"cuts": [{"in": <sec>, "out": <sec>}]}
HARD BOUND: every timestamp must lie within the clip's real duration. Never exceed it.
Pick 8 cuts of 2-3 seconds each, spread across the whole clip, in increasing order."""

USER = "<clips>\nclip0: 291.7s\n</clips>\nPick the 8 best moments. Return ONLY the JSON."


async def one(temp: float | None) -> tuple[int, int, float]:
    from packages.llm.gateway import acompletion

    s = get_settings()
    kw = call_kwargs(model=f"gemini/{s.dub_vision_model}", effort=s.dub_vision_effort)
    if temp is not None:
        kw["temperature"] = temp
    kw["timeout"] = 120
    resp = await acompletion(
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}], **kw
    )
    raw = resp.choices[0].message.content or ""
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    cuts = json.loads(raw).get("cuts", [])
    over = sum(1 for c in cuts if float(c.get("out", 0)) > 291.7 or float(c.get("in", 0)) < 0)
    span = max((float(c.get("out", 0)) for c in cuts), default=0.0)
    return len(cuts), over, span


async def main() -> None:
    sync_llm_env()
    print(f"model={get_settings().dub_vision_model} effort={get_settings().dub_vision_effort}")
    for temp in TEMPS:
        label = "default(ไม่ตั้ง)" if temp is None else f"temperature={temp}"
        rows: list[tuple[int, int, float]] = []
        for i in range(SAMPLES):
            try:
                rows.append(await one(temp))
            except Exception as exc:  # noqa: BLE001
                print(f"  {label} #{i + 1}: ERROR {type(exc).__name__}: {str(exc)[:160]}")
        if not rows:
            print(f"{label}: ทุกครั้ง error — ค่านี้ใช้ไม่ได้")
            continue
        counts = [r[0] for r in rows]
        overs = [r[1] for r in rows]
        spans = [r[2] for r in rows]
        print(
            f"{label:<22} cuts={counts} เกินขอบ={overs} "
            f"ปลายสุด={[round(x, 1) for x in spans]} "
            f"| ผลต่างกันกี่แบบ: {len(set(map(tuple, [(c, o) for c, o in zip(counts, overs)])))}/{len(rows)}"
        )


if __name__ == "__main__":
    asyncio.run(main())
