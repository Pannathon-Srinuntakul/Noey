"""Plan-only evaluation of the layer-2 trim on chosen sweep picks.

Prints the full kept script per clip (piece boundaries marked) so coherence can
be READ, not guessed from counts. No rendering, no Scribe — one Gemini call per
clip against the cached transcript.

Usage (from backend/):

    python scripts/trim_eval.py <sweep_index...>     # e.g. 2 3 5  (1-based)
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from packages.video.speech_select import trim_span_content  # noqa: E402

U = "098d8935-a659-4982-be9f-755d2119d96f"
BASE = pathlib.Path(f"data/video_outputs/{U}")
PROJ = (
    pathlib.Path(os.environ["APPDATA"]) / "noey-video-edit" / "projects"
    / "504b8b59-ced3-43b8-a642-ef8f5209e5b4"
)


async def main() -> None:
    idxs = [int(a) for a in sys.argv[1:]] or [2, 3, 5]
    segs = json.loads((BASE / "transcript.json").read_text(encoding="utf-8"))["segments"]
    plan = json.loads(
        (PROJ / "highlights" / "sweep" / "plan.json").read_text(encoding="utf-8")
    )

    for i in idxs:
        p = plan[i - 1]
        a, b = p["segFrom"], p["segTo"]
        r = await trim_span_content(
            segs, seg_from=a, seg_to=b, title=p["title"], why=p["why"],
        )
        kept = {n for x, y in r for n in range(x, y + 1)}
        dur = sum(float(segs[y]["end"]) - float(segs[x]["start"]) for x, y in r)
        old = {n for x, y in p["pieces"] for n in range(x, y + 1)}
        print(f"\n{'=' * 76}")
        print(f"s{i:02d} {p['title']}")
        print(f"span #{a}-#{b} ({b - a + 1} ปย.) | เดิมเก็บ {len(old)} | ใหม่เก็บ {len(kept)} "
              f"({len(r)} ชิ้น, {dur:.0f}s)")
        print(f"{'-' * 76}")
        piece_no = 0
        for x, y in r:
            piece_no += 1
            gap = ""
            if piece_no > 1:
                prev_end = [q for q in r if q[1] < x]
                if prev_end:
                    skipped = x - prev_end[-1][1] - 1
                    gap = f"   …(ข้าม {skipped} ปย.)…"
            print(f"[ชิ้น {piece_no}]{gap}")
            for n in range(x, y + 1):
                print(f"   #{n} {segs[n]['text'].strip()[:88]}")


if __name__ == "__main__":
    asyncio.run(main())
