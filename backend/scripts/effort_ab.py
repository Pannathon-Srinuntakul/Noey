"""A/B one dub cut at two thinking levels: what does `high` buy over `medium`?

Production sets ``DUB_VISION_EFFORT=high``; the code's own default is
``medium``. Measured on production rows, thinking is ~95% of the fixed cost of
a cut (packages/billing/limits.py), so the setting is worth roughly a doubling
of everyone's clip count — IF the cheaper level cuts as well. Nobody has ever
measured it, which is the whole reason this script exists.

It runs the SAME proxy through ``generate_dub_edit_script_video`` once per
effort level, with everything else held fixed: same model, same fps, same
prompt version, same brief and voiceover script. The only variable is
``settings.dub_vision_effort``.

Vendor usage is captured by wrapping the gateway call rather than by reading
``core.llm_usage_logs`` — this is a probe, not a billed run, so it opens no
database session and writes no usage rows.

Run from backend/ with a real GEMINI_API_KEY. It spends real money: roughly
฿12 per round at ``high`` on a 3-minute clip, less at ``medium``.

    python scripts/effort_ab.py path/to/proxy.mp4 --rounds 2
    python scripts/effort_ab.py --efforts high,medium,low --rounds 1

Each round of each level is a separate model call, because the model is not
deterministic — one round tells you almost nothing about which level cuts
better, and the token figures move by ±30% run to run (measured: production
output ranged 12,250–32,578 across 15 calls at a fixed setting). Two rounds is
the minimum worth reading; three is better if the budget allows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

DEFAULT_PROXY = "data/ab/20260925-184300/proxy_000.mp4"

#: What the REAL pipeline sends. ``services/worker/tasks.py`` passes
#: ``user_script=proj.user_script or ""`` — empty unless the creator wrote one
#: first, which is the exception. With it empty the model writes the script
#: itself and follows the prompt's own no-target rule (45 s minimum, 50-60 s
#: aim, 12-18 lines, >=10 segments). Supplying a script here instead pins the
#: cut to that many lines and measures a job nobody runs: a four-line script
#: produced a 14-second cut where production produces 45-60.
BRIEF = "รีวิวสินค้าสำหรับ TikTok affiliate"
SCRIPT = ""


def _ffprobe_duration(path: pathlib.Path) -> float:
    import subprocess

    from packages.video.ffmpeg_bin import ffprobe_cmd

    out = subprocess.run(
        [ffprobe_cmd(), "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _usage_of(resp: Any) -> dict[str, int]:
    """Vendor token counts off a LiteLLM response, however it names them."""
    u = getattr(resp, "usage", None) or {}
    get = (lambda k: u.get(k)) if isinstance(u, dict) else (lambda k: getattr(u, k, None))
    details = get("prompt_tokens_details") or {}
    cached = (
        details.get("cached_tokens") if isinstance(details, dict)
        else getattr(details, "cached_tokens", None)
    ) or 0
    return {
        "vendor_in": int(get("prompt_tokens") or 0),
        "vendor_out": int(get("completion_tokens") or 0),
        "cached": int(cached),
    }


async def _one_round(
    proxy: pathlib.Path, duration: float, effort: str, tag: str, script_text: str = SCRIPT
) -> dict[str, Any]:
    """One cut at one effort level. Returns the cut plus what it cost."""
    import os

    from packages.billing import rate_card
    from packages.core.settings import get_settings, reload_settings
    from packages.llm import gateway
    from packages.video import dub_ai, quality

    os.environ["DUB_VISION_EFFORT"] = effort
    reload_settings()
    settings = get_settings()
    assert settings.dub_vision_effort == effort, "the effort override did not take"

    calls: list[dict[str, int]] = []
    real = gateway.acompletion_stream_thinking

    async def capturing(*args: Any, **kwargs: Any) -> Any:
        resp = await real(*args, **kwargs)
        calls.append(_usage_of(resp))
        return resp

    gateway.acompletion_stream_thinking = capturing  # type: ignore[assignment]
    started = time.monotonic()
    try:
        system, prose = dub_ai.select_video_edit_prompts(no_voiceover=False)
        script = await dub_ai.generate_dub_edit_script_video(
            [("c1", proxy, duration)],
            brief=BRIEF,
            user_script=script_text,
            target_duration_sec=None,
            project_uid=f"effort-ab-{tag}",
            system=system,
            default_cut_style_prose=prose,
            model=quality.engine_model("pro"),
            fps=quality.precision_fps("high"),
            # Explicit, so the A/B keeps comparing what it says it compares even
            # though effort now normally arrives from the project's Engine tier.
            effort=effort,
        )
    finally:
        gateway.acompletion_stream_thinking = real  # type: ignore[assignment]
    elapsed = time.monotonic() - started

    vin = sum(c["vendor_in"] for c in calls)
    vout = sum(c["vendor_out"] for c in calls)
    cached = sum(c["cached"] for c in calls)
    ours = rate_card.tokens_for_llm(quality.engine_model("pro"), vin, cached, vout)
    segments = list(script.get("segments") or [])
    # Field names come from timeline.normalize_dub_edit_script, not from the
    # model's raw answer: sourceClip / sourceIn / sourceOut / durationSec.
    lengths = [round(float(s.get("durationSec") or 0.0), 2) for s in segments]
    return {
        "tag": tag,
        "effort": effort,
        "wall_sec": round(elapsed, 1),
        "calls": len(calls),
        "vendor_in": vin,
        "vendor_out": vout,
        "cached": cached,
        "our_tokens": ours,
        "cost_thb": round(ours * 50 / 1_000_000, 4),
        "segments": len(segments),
        "out_sec": round(sum(lengths), 2),
        "cut_lengths": lengths,
        "cuts": [
            {
                "clip": s.get("sourceClip"),
                "start": round(float(s.get("sourceIn") or 0.0), 2),
                "end": round(float(s.get("sourceOut") or 0.0), 2),
                "sec": round(float(s.get("durationSec") or 0.0), 2),
                "line": (s.get("voiceoverScript") or "")[:48],
                "alternates": len(s.get("alternates") or []),
            }
            for s in segments
        ],
    }


def _overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Share of B's screen time that A also chose — how much the two agree."""
    total = sum(c["end"] - c["start"] for c in b["cuts"]) or 1.0
    shared = 0.0
    for cb in b["cuts"]:
        for ca in a["cuts"]:
            if ca["clip"] != cb["clip"]:
                continue
            shared += max(0.0, min(ca["end"], cb["end"]) - max(ca["start"], cb["start"]))
    return round(shared / total, 3)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("proxy", nargs="?", default=DEFAULT_PROXY, help="proxy MP4 to cut")
    ap.add_argument("--efforts", default="high,medium", help="comma-separated levels")
    ap.add_argument("--rounds", type=int, default=2, help="rounds per level")
    ap.add_argument("--out", default="", help="report path (default: beside the proxy)")
    ap.add_argument("--script", default=SCRIPT,
                    help="voiceover lines to cut against; empty (the default) lets the model write them")
    args = ap.parse_args()

    proxy = pathlib.Path(args.proxy).resolve()
    if not proxy.exists():
        print(f"no such proxy: {proxy}", file=sys.stderr)
        return 2
    duration = _ffprobe_duration(proxy)
    efforts = [e.strip() for e in args.efforts.split(",") if e.strip()]

    print(f"clip   {proxy}  ({duration:.1f}s)")
    print(f"levels {', '.join(efforts)} x {args.rounds} round(s)\n")

    runs: list[dict[str, Any]] = []
    for effort in efforts:
        for r in range(1, args.rounds + 1):
            tag = f"{effort}-{r}"
            print(f"  {tag} … ", end="", flush=True)
            try:
                run = await _one_round(proxy, duration, effort, tag, args.script)
            except Exception as exc:  # noqa: BLE001 — one bad round must not lose the rest
                print(f"FAILED: {type(exc).__name__}: {exc}")
                runs.append({"tag": tag, "effort": effort, "error": f"{type(exc).__name__}: {exc}"})
                continue
            runs.append(run)
            print(
                f"{run['segments']} cuts, {run['out_sec']}s out · "
                f"in {run['vendor_in']:,} out {run['vendor_out']:,} · "
                f"ours {run['our_tokens']:,} (฿{run['cost_thb']}) · {run['wall_sec']}s"
            )

    ok = [r for r in runs if "error" not in r]
    summary: dict[str, Any] = {}
    for effort in efforts:
        mine = [r for r in ok if r["effort"] == effort]
        if not mine:
            continue
        n = len(mine)
        summary[effort] = {
            "rounds": n,
            "avg_vendor_out": round(sum(r["vendor_out"] for r in mine) / n),
            "avg_our_tokens": round(sum(r["our_tokens"] for r in mine) / n),
            "avg_cost_thb": round(sum(r["cost_thb"] for r in mine) / n, 4),
            "avg_segments": round(sum(r["segments"] for r in mine) / n, 1),
            "avg_out_sec": round(sum(r["out_sec"] for r in mine) / n, 1),
            "avg_wall_sec": round(sum(r["wall_sec"] for r in mine) / n, 1),
        }

    report = {
        "clip": str(proxy),
        "duration_sec": duration,
        "model": None,
        "fps": None,
        "efforts": efforts,
        "rounds": args.rounds,
        "summary": summary,
        "runs": runs,
    }
    from packages.video import quality

    report["model"] = quality.engine_model("pro")
    report["fps"] = quality.precision_fps("high")
    # How much the two levels agree on WHICH footage to use, both directions.
    if len(efforts) == 2 and all(e in summary for e in efforts):
        a = next(r for r in ok if r["effort"] == efforts[0])
        b = next(r for r in ok if r["effort"] == efforts[1])
        report["overlap"] = {
            f"{efforts[1]}_covered_by_{efforts[0]}": _overlap(a, b),
            f"{efforts[0]}_covered_by_{efforts[1]}": _overlap(b, a),
        }

    out = pathlib.Path(args.out) if args.out else proxy.parent / "effort-ab.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nreport → {out}")

    if summary:
        print(f"\n{'level':<8}{'out tok':>10}{'our tok':>11}{'฿':>9}{'cuts':>7}{'out s':>8}{'wall s':>8}")
        for effort, s in summary.items():
            print(
                f"{effort:<8}{s['avg_vendor_out']:>10,}{s['avg_our_tokens']:>11,}"
                f"{s['avg_cost_thb']:>9.2f}{s['avg_segments']:>7}{s['avg_out_sec']:>8}{s['avg_wall_sec']:>8}"
            )
        if len(summary) == 2:
            hi, lo = list(summary.values())
            if lo["avg_our_tokens"]:
                print(f"\n{efforts[0]} costs {hi['avg_our_tokens'] / lo['avg_our_tokens']:.2f}x {efforts[1]}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
