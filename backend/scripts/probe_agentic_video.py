"""A/B the two ways Gemini can read a video, on a real clip.

    cd backend && python scripts/probe_agentic_video.py path/to/clip.mp4 [--rounds 3]

Runs the SAME cut-analysis request N times per mode and prints, per run, the
cut boundaries it returned, the video input tokens it billed, and the wall
clock. Then a summary comparing the modes.

Why N rounds and not one: this model does not answer identically twice. The
project's own rule is to judge a prompt or setting change on at least three
live runs, never one — a single run that looks better is noise until it repeats.

Read the output this way:

* **video tokens** is the only proof the mode reached the wire at all. A dropped
  field looks exactly like a working one. Agentic should be far below static;
  if the two are within a few percent, the request did not change.
* **cut spread** is whether the mode is usable here. Our job is every boundary
  across the whole clip, to a tenth of a second. A mode that finds different
  cuts each round is worse than one that finds slightly fewer, every time.
* **cuts found** catches the opposite failure: a mode that is stable because it
  is not looking hard enough.

Uses the fake-AI-free path and bills real tokens against the probe account —
it is a real call to a real vendor. Run it on one short clip, not a library.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import statistics
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))


async def _run_once(clip: pathlib.Path, mode: str, fps: int) -> dict:
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"
    file_id = await upload_gemini_file(clip, mime_type="video/mp4")
    try:
        # Deliberately the narrowest possible prompt: this probe compares how
        # the file is READ, so anything else in the request is noise.
        content = [
            {"type": "text", "text": (
                "List every visual cut point in this clip as JSON: "
                '{"cuts":[{"atSec": <number>, "what": "<short phrase>"}]}. '
                "A cut point is where the shot changes — a new angle, framing or subject. "
                "Report seconds from the start, to two decimals. JSON only."
            )},
            gemini_video_block(file_id, fps=fps if mode == "static" else 0, processing=mode),
        ]
        extra = call_kwargs(model=model, effort=settings.dub_vision_effort)
        extra["timeout"] = settings.dub_vision_timeout_sec
        t0 = time.monotonic()
        # call_kwargs already carries the model — the gateway takes messages
        # positionally and everything else through **extra.
        resp = await acompletion([{"role": "user", "content": content}], **extra)
        elapsed = time.monotonic() - t0
    finally:
        await delete_gemini_files([file_id])

    text = (resp.choices[0].message.content or "").strip()
    usage = getattr(resp, "usage", None)
    cuts: list[float] = []
    try:
        body = text[text.index("{"): text.rindex("}") + 1]
        cuts = [float(c["atSec"]) for c in json.loads(body).get("cuts", []) if "atSec" in c]
    except Exception as exc:  # noqa: BLE001 — a malformed answer IS a result worth seeing
        print(f"  (unparsed answer: {exc})")
    return {
        "mode": mode,
        "cuts": sorted(cuts),
        "prompt_tokens": getattr(usage, "prompt_tokens", None),
        "completion_tokens": getattr(usage, "completion_tokens", None),
        "sec": round(elapsed, 1),
        "raw_head": text[:120],
    }


def truth_from_edit_script(path: pathlib.Path) -> list[float]:
    """Cut boundaries of an already-rendered clip, from the script that made it.

    A rendered `final_silent.mp4` has cuts we know exactly — the segment
    durations that produced it. That turns "which mode is more accurate" from a
    matter of opinion into a measurement.
    """
    segments = json.loads(path.read_text(encoding="utf-8"))["segments"]
    out: list[float] = []
    t = 0.0
    for seg in segments:
        t += float(seg.get("durationSec") or 0)
        out.append(round(t, 2))
    return out[:-1]  # the end of the last segment is the end of the file


def score(found: list[float], truth: list[float], tol: float) -> dict:
    """Greedy match within ``tol`` seconds, then precision / recall / error."""
    remaining = list(truth)
    errors: list[float] = []
    for f in found:
        if not remaining:
            break
        nearest = min(remaining, key=lambda t: abs(t - f))
        if abs(nearest - f) <= tol:
            errors.append(abs(nearest - f))
            remaining.remove(nearest)
    hit = len(errors)
    precision = hit / len(found) if found else 0.0
    recall = hit / len(truth) if truth else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "hit": hit,
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "mean_err": round(statistics.fmean(errors), 3) if errors else None,
    }


def _spread(runs: list[dict]) -> float | None:
    """How far apart the rounds' cut lists are, in seconds.

    Compares each round's Nth cut against the others'. A mode that is stable
    scores near zero; one that re-decides every round does not.
    """
    lists = [r["cuts"] for r in runs if r["cuts"]]
    if len(lists) < 2:
        return None
    shortest = min(len(x) for x in lists)
    if shortest == 0:
        return None
    return round(
        statistics.fmean(
            statistics.pstdev([lst[i] for lst in lists]) for i in range(shortest)
        ),
        3,
    )


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", type=pathlib.Path)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--fps", type=int, default=0, help="static sampling rate; 0 = provider default")
    ap.add_argument(
        "--truth",
        type=pathlib.Path,
        help="edit_script.json that produced this clip — turns the run into a scored test",
    )
    ap.add_argument("--tol", type=float, default=0.25, help="seconds a cut may be off and still count")
    args = ap.parse_args()
    if not args.clip.is_file():
        print(f"no such clip: {args.clip}")
        return 2

    from packages.core.settings import get_settings

    fps = args.fps or get_settings().dub_precision_high_fps
    print(f"clip={args.clip.name} rounds={args.rounds} static_fps={fps}\n")

    results: dict[str, list[dict]] = {"static": [], "agentic": []}
    for mode in ("static", "agentic"):
        for i in range(args.rounds):
            r = await _run_once(args.clip, mode, fps)
            results[mode].append(r)
            print(
                f"{mode:8s} #{i + 1}  tokens_in={r['prompt_tokens']:>9}  "
                f"{r['sec']:>5.1f}s  cuts={len(r['cuts']):>3}  {r['cuts'][:6]}"
            )
        print()

    truth = truth_from_edit_script(args.truth) if args.truth else []
    if truth:
        print(f"ground truth: {len(truth)} cuts, tolerance ±{args.tol}s\n{truth}\n")

    print("=== summary ===")
    for mode, runs in results.items():
        toks = [r["prompt_tokens"] for r in runs if r["prompt_tokens"]]
        cuts = [len(r["cuts"]) for r in runs]
        line = (
            f"{mode:8s} tokens_in avg={statistics.fmean(toks) if toks else 0:>10,.0f}  "
            f"cuts avg={statistics.fmean(cuts):>5.1f}  "
            f"spread={_spread(runs)}s  "
            f"sec avg={statistics.fmean(r['sec'] for r in runs):.1f}"
        )
        if truth:
            scores = [score(r["cuts"], truth, args.tol) for r in runs]
            line += (
                f"  f1 avg={statistics.fmean(s['f1'] for s in scores):.3f}"
                f"  recall avg={statistics.fmean(s['recall'] for s in scores):.3f}"
            )
            errs = [s["mean_err"] for s in scores if s["mean_err"] is not None]
            if errs:
                line += f"  err avg={statistics.fmean(errs):.3f}s"
        print(line)
    s_tok = [r["prompt_tokens"] for r in results["static"] if r["prompt_tokens"]]
    a_tok = [r["prompt_tokens"] for r in results["agentic"] if r["prompt_tokens"]]
    if s_tok and a_tok:
        saved = 1 - statistics.fmean(a_tok) / statistics.fmean(s_tok)
        print(f"\nagentic uses {saved:+.0%} of static's input tokens")
        if abs(saved) < 0.05:
            print(
                "WARNING: within 5% — the mode probably never reached the wire. "
                "Check packages/llm/gemini_video_mode.py."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
