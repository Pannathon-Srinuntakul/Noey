"""End-to-end A/B of Gemini's two video reading modes, on one real clip.

    cd backend && python scripts/ab_video_processing.py CLIP.mov --rounds 3

Runs the REAL dub_first chain — the same proxy parameters, the same prompt, the
same model and precision tier the product uses — once per round per mode, and
renders each result to an MP4 you can watch. Then reports what each round cost
in baht (priced with our own rate card, not a guess) and how long it took.

Not `probe_agentic_video.py`: that one asks a narrow "list the cut points"
question to isolate the mode. This one asks the product's own question and
produces the product's own output, because a mode that scores well on cut
detection and then writes a worse edit is not an improvement.

The clip is never sent whole. It is normalized, a proxy is derived with the
product's parameters (480 high, 12 fps, CRF 28, no audio), and only the proxy
goes to the vendor — same as a real run.

Output lands in `data/ab/<stamp>/`: one MP4 per round per mode, the edit script
beside it, and `report.json` with every number quoted here.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import shutil
import statistics
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

MODES = ("static", "agentic")


def _probe(path: pathlib.Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "format=duration,size", "-show_entries", "stream=width,height",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    d = json.loads(out)
    st = (d.get("streams") or [{}])[0]
    fmt = d.get("format") or {}
    return {
        "duration": float(fmt.get("duration") or 0),
        "bytes": int(fmt.get("size") or 0),
        "width": int(st.get("width") or 0),
        "height": int(st.get("height") or 0),
    }


def _normalize(src: pathlib.Path, dest: pathlib.Path) -> None:
    """What ingest does: land as H.264 in an MP4, copying packets when it can."""
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    subprocess.run(
        [ffmpeg_cmd(), "-v", "error", "-y", "-i", str(src),
         "-c", "copy", "-movflags", "+faststart", str(dest)],
        check=True,
    )


def _proxy(src: pathlib.Path, dest: pathlib.Path) -> None:
    """The product's proxy parameters — desktop/sidecar/sidecar/proxy.py."""
    from packages.video.ffmpeg_bin import ffmpeg_cmd

    subprocess.run(
        [ffmpeg_cmd(), "-v", "error", "-y", "-i", str(src),
         "-vf", "scale=-2:480,fps=12", "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dest)],
        check=True,
    )


#: Owner's fixed economics (docs/token-billing-plan.md): what 1M of our tokens
#: costs us, and what a plan sells them for. Quoted here so the script prints
#: baht without needing the database and the FX rate.
COST_THB_PER_M = 50.0
SELL_THB_PER_M = 250.0


class _Meter:
    """Totals for one model call, taken from the response the gateway returns.

    The analysis function does not hand its usage back, so the gateway's
    ``acompletion`` is wrapped for the duration of a round. Wrapping rather than
    re-implementing keeps the call itself — retries, guard, scrubbing — exactly
    the one the product makes.
    """

    def __init__(self) -> None:
        self.calls = 0
        self.vendor_in = 0
        self.vendor_out = 0
        self.cached = 0

    def add(self, resp) -> None:
        from packages.llm.usage import extract_cached_tokens, extract_usage_tokens

        usage = getattr(resp, "usage", None)
        if usage is None:
            return
        prompt, completion = extract_usage_tokens(usage)
        self.calls += 1
        self.vendor_in += int(prompt or 0)
        self.vendor_out += int(completion or 0)
        self.cached += int(extract_cached_tokens(usage) or 0)

    def priced(self, model: str) -> dict:
        from packages.billing import rate_card

        ours = rate_card.tokens_for_llm(
            model=model,
            input_tokens=self.vendor_in,
            cached_tokens=self.cached,
            output_tokens=self.vendor_out,
        )
        return {
            "calls": self.calls,
            "vendor_in": self.vendor_in,
            "vendor_out": self.vendor_out,
            "cached": self.cached,
            "our_tokens": ours,
            "cost_thb": round(ours / 1_000_000 * COST_THB_PER_M, 4),
            "price_thb": round(ours / 1_000_000 * SELL_THB_PER_M, 4),
        }


async def _one_round(
    *, proxy: pathlib.Path, norm: pathlib.Path, duration: float, mode: str,
    out_dir: pathlib.Path, tag: str, fps: int, model: str,
) -> dict:
    from packages.core.settings import get_settings
    from packages.video.dub_ai import generate_dub_edit_script_video, select_video_edit_prompts
    from packages.video.dub_render import concat_stream_copy, trim_segments_silent

    settings = get_settings()
    system, prose = select_video_edit_prompts(no_voiceover=False)

    # The mode is a setting the analysis reads, so set it for this round only.
    previous = settings.dub_video_processing
    object.__setattr__(settings, "dub_video_processing", mode)

    # The video call streams (it surfaces the model's thinking), so the function
    # to wrap is acompletion_stream_thinking, not acompletion. dub_ai imports it
    # INSIDE the function, so patching the gateway module is enough — the import
    # happens after this line runs.
    from packages.llm import gateway

    meter = _Meter()
    original = gateway.acompletion_stream_thinking

    async def metered(*a, **k):
        resp = await original(*a, **k)
        meter.add(resp)
        return resp

    gateway.acompletion_stream_thinking = metered

    t0 = time.monotonic()
    try:
        script = await generate_dub_edit_script_video(
            [("clip0", proxy, duration)],
            brief="",
            user_script="",          # empty = the model writes the voiceover itself
            target_duration_sec=None,  # empty = the model chooses the length
            project_uid=f"ab-{tag}",
            system=system,
            default_cut_style_prose=prose,
            model=model,
            fps=fps if mode == "static" else 0,
        )
    finally:
        object.__setattr__(settings, "dub_video_processing", previous)
        gateway.acompletion_stream_thinking = original
    analyze_sec = round(time.monotonic() - t0, 1)

    segments = script.get("segments") or []
    round_dir = out_dir / tag
    round_dir.mkdir(parents=True, exist_ok=True)
    (round_dir / "edit_script.json").write_text(
        json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    t1 = time.monotonic()
    rendered = None
    if segments:
        clips = trim_segments_silent([norm], segments, round_dir / "clips")
        rendered = round_dir / f"{tag}.mp4"
        concat_stream_copy(clips, rendered, round_dir / "concat.txt")
        shutil.rmtree(round_dir / "clips", ignore_errors=True)
    render_sec = round(time.monotonic() - t1, 1)

    return {
        "mode": mode,
        "tag": tag,
        "segments": len(segments),
        "out_sec": round(sum(float(s.get("durationSec") or 0) for s in segments), 2),
        "analyze_sec": analyze_sec,
        "render_sec": render_sec,
        "video": str(rendered) if rendered else None,
        "cost": meter.priced(model) if meter.calls else None,
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", type=pathlib.Path)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--engine", default="pro", choices=["lite", "pro"])
    ap.add_argument("--precision", default="high", choices=["standard", "high"])
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("data/ab"))
    ap.add_argument("--yes", action="store_true", help="skip the cost estimate prompt")
    args = ap.parse_args()

    if not args.clip.is_file():
        print(f"no such clip: {args.clip}")
        return 2

    from packages.billing.estimate import video_input_tokens
    from packages.video.quality import resolve

    model, fps = resolve(args.engine, args.precision)
    info = _probe(args.clip)
    per_call = video_input_tokens(info["duration"], args.precision)
    print(
        f"clip      {args.clip.name}  {info['width']}x{info['height']}  "
        f"{info['duration']:.1f}s  {info['bytes'] / 1e6:.0f} MB\n"
        f"engine    {args.engine} -> {model}   precision {args.precision} -> fps {fps}\n"
        f"rounds    {args.rounds} per mode ({args.rounds * 2} model calls)\n"
        f"estimate  static ~{per_call:,} video tokens per call; agentic unknown, "
        f"claimed far lower\n"
    )
    if not args.yes:
        print("re-run with --yes to actually spend it")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = args.out / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    norm = out_dir / "norm_000.mp4"
    proxy = out_dir / "proxy_000.mp4"
    t0 = time.monotonic()
    _normalize(args.clip, norm)
    _proxy(norm, proxy)
    prep_sec = round(time.monotonic() - t0, 1)
    pinfo = _probe(proxy)
    print(
        f"prep      {prep_sec}s   proxy {pinfo['width']}x{pinfo['height']} "
        f"{pinfo['bytes'] / 1e6:.1f} MB\n"
    )

    runs: list[dict] = []
    for mode in MODES:
        for i in range(args.rounds):
            tag = f"{mode}-{i + 1}"
            try:
                r = await _one_round(
                    proxy=proxy, norm=norm, duration=info["duration"], mode=mode,
                    out_dir=out_dir, tag=tag, fps=fps, model=model,
                )
            except Exception as exc:  # noqa: BLE001 — a failed round is a result
                print(f"{tag:12s} FAILED {type(exc).__name__}: {str(exc)[:160]}")
                runs.append({"mode": mode, "tag": tag, "error": str(exc)[:400]})
                continue
            cost = r.get("cost")
            runs.append(r)
            print(
                f"{tag:12s} cuts={r['segments']:>3}  out={r['out_sec']:>6.1f}s  "
                f"analyze={r['analyze_sec']:>6.1f}s  render={r['render_sec']:>5.1f}s  "
                + (f"in={cost['vendor_in']:>8,} out={cost['vendor_out']:>6,} "
                   f"cost=฿{cost['cost_thb']:.3f}" if cost else "usage unavailable")
            )
        print()

    report = {
        "clip": str(args.clip), "clip_info": info, "proxy_info": pinfo,
        "engine": args.engine, "precision": args.precision, "model": model,
        "static_fps": fps, "rounds": args.rounds, "prep_sec": prep_sec, "runs": runs,
    }
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")

    print("=== summary ===")
    for mode in MODES:
        ok = [r for r in runs if r["mode"] == mode and "error" not in r and r.get("cost")]
        if not ok:
            print(f"{mode:8s} no successful round")
            continue
        print(
            f"{mode:8s} cuts avg={statistics.fmean(r['segments'] for r in ok):>5.1f}  "
            f"out avg={statistics.fmean(r['out_sec'] for r in ok):>6.1f}s  "
            f"analyze avg={statistics.fmean(r['analyze_sec'] for r in ok):>6.1f}s  "
            f"tokens_in avg={statistics.fmean(r['cost']['vendor_in'] for r in ok):>9,.0f}  "
            f"cost avg=฿{statistics.fmean(r['cost']['cost_thb'] for r in ok):.3f}  "
            f"total=฿{sum(r['cost']['cost_thb'] for r in ok):.3f}"
        )
    s = [r for r in runs if r["mode"] == "static" and r.get("cost")]
    a = [r for r in runs if r["mode"] == "agentic" and r.get("cost")]
    if s and a:
        si = statistics.fmean(r["cost"]["vendor_in"] for r in s)
        ai = statistics.fmean(r["cost"]["vendor_in"] for r in a)
        print(f"\nagentic input tokens are {ai / si:.0%} of static's")
        if abs(1 - ai / si) < 0.05:
            print(
                "WARNING: within 5% — the mode probably never reached the wire, "
                "so both columns are the same experiment (packages/llm/gemini_video_mode.py)."
            )
    print(f"\nfiles: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
