"""Operational probe: does LiteLLM pass Gemini video fps sampling metadata through?

Gemini samples uploaded video at 1 fps by default. The Gemini API supports a
per-part `video_metadata: {"fps": N}` override, but it is unclear whether
LiteLLM forwards it (per content block or as a top-level kwarg) or silently
drops it. This probe uploads one clip and asks the same hard-cut-counting
question three ways:

    V1  baseline           — standard gemini_video_block(file_id), no fps hint
    V2  per-block metadata — same block with "video_metadata": {"fps": 5}
                             injected inside the "file" dict
    V3  top-level kwarg    — baseline block + video_metadata={"fps": 5} passed
                             directly to litellm.acompletion (may raise)

Ground truth comes from PySceneDetect (packages.video.scene.detect_scenes) on
the same clip. Two signals prove passthrough:

    1. prompt_tokens — Gemini bills ~tokens/sec-of-video at the sampled rate,
       so a real 5 fps override inflates V2/V3 input tokens well above V1.
    2. cut accuracy  — sub-second cuts invisible at 1 fps get caught at 5 fps,
       so cutCount/timestamps move closer to the PySceneDetect ground truth.

Decision rule: only enable a future `settings.cut_style_ref_fps` (i.e. start
attaching fps metadata to Gemini video uploads) if V2 or V3 PROVABLY changes
sampling — identical token counts and answers mean LiteLLM dropped the field,
so keep CUT_STYLE_REF_FPS=0.

Run from backend/ (real GEMINI_API_KEY required; costs a few video-inference
calls on settings.dub_vision_model):

    python scripts/probe_gemini_fps.py path/to/clip.mp4
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

PROMPT = (
    "Count the hard cuts in this video and list each cut's timestamp to 0.1s "
    'precision. Answer as JSON: {"cutCount": n, "timestamps": [..]}'
)

PROBE_FPS = 5


def _ground_truth(clip: Path) -> dict[str, Any] | None:
    """PySceneDetect cut list for the clip; None (with a warning) on failure."""
    try:
        from packages.video.scene import detect_scenes

        scenes = detect_scenes(clip)
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: PySceneDetect ground truth failed ({type(exc).__name__}: {exc}) — continuing without it")
        return None
    # N scenes → N-1 hard cuts, one at each interior scene boundary.
    timestamps = [round(float(s["start"]), 3) for s in scenes[1:]]
    print(f"Ground truth (PySceneDetect): {len(timestamps)} hard cuts across {len(scenes)} scenes")
    print(f"  cut timestamps: {timestamps}")
    return {"cut_count": len(timestamps), "timestamps": timestamps}


def _parse_cut_json(raw: str) -> dict[str, Any] | None:
    """Tolerant extraction of the {"cutCount": .., "timestamps": [..]} object."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def _run_variant(
    label: str,
    note: str,
    content: list[dict[str, Any]],
    base_kwargs: dict[str, Any],
    extra_kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One litellm.acompletion call; prints raw text + usage, returns a summary dict."""
    import litellm

    result: dict[str, Any] = {"label": label, "note": note}
    print(f"\n=== {label}: {note} ===")
    t0 = time.monotonic()
    try:
        resp = await litellm.acompletion(
            messages=[{"role": "user", "content": content}],
            **base_kwargs,
            **(extra_kwargs or {}),
        )
        elapsed = round(time.monotonic() - t0, 1)
        raw = str(resp.choices[0].message.content or "")
        usage = getattr(resp, "usage", None)
        inp = getattr(usage, "prompt_tokens", None)
        out = getattr(usage, "completion_tokens", None)
        result.update({"raw": raw, "prompt_tokens": inp, "completion_tokens": out})
        print(f"elapsed={elapsed}s  tokens: input={inp}  output={out}")
        print(f"--- raw response ---\n{raw}\n--- end raw response ---")
        parsed = _parse_cut_json(raw)
        if parsed is not None:
            result["cut_count"] = parsed.get("cutCount")
            result["timestamps"] = parsed.get("timestamps")
            print(f"parsed: cutCount={result['cut_count']}  timestamps={result['timestamps']}")
        else:
            print("WARN: could not parse cut JSON from response")
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        print(f"FAIL after {round(time.monotonic() - t0, 1)}s")
        print(f"provider error (verbatim): {type(exc).__name__}: {exc}")
    return result


def _print_verdict(truth: dict[str, Any] | None, results: list[dict[str, Any]]) -> None:
    """Compare variants against ground truth and print the go/no-go line."""
    print("\n" + "=" * 60)
    print("VERDICT")
    print("=" * 60)
    if truth is not None:
        print(f"PySceneDetect ground truth: cutCount={truth['cut_count']}  timestamps={truth['timestamps']}")
    else:
        print("PySceneDetect ground truth: unavailable (detection failed)")
    for r in results:
        if "error" in r:
            print(f"{r['label']}: ERROR — {r['error']}")
        else:
            print(
                f"{r['label']}: cutCount={r.get('cut_count')}  "
                f"input_tokens={r.get('prompt_tokens')}  timestamps={r.get('timestamps')}"
            )

    v1, v2, v3 = results

    def _tokens_inflated(v: dict[str, Any]) -> bool:
        """Input tokens well above baseline → more video frames were sampled."""
        base = v1.get("prompt_tokens")
        cur = v.get("prompt_tokens")
        if not isinstance(base, int) or not isinstance(cur, int) or base <= 0:
            return False
        return cur > base * 1.5

    def _answer_changed(v: dict[str, Any]) -> bool:
        return (
            "error" not in v
            and "error" not in v1
            and v.get("cut_count") is not None
            and v.get("cut_count") != v1.get("cut_count")
        )

    working = [
        v["label"]
        for v in (v2, v3)
        if "error" not in v and (_tokens_inflated(v) or _answer_changed(v))
    ]
    print("-" * 60)
    if "error" in v1:
        print("INCONCLUSIVE: baseline V1 failed — fix that before judging fps passthrough.")
    elif working:
        print(f"fps passthrough WORKS via {'/'.join(working)}")
        print(
            "  → evidence: input-token inflation and/or a changed cut answer vs V1. "
            f"Safe to add cut_style_ref_fps to settings (probe used fps={PROBE_FPS})."
        )
        if truth is not None:
            print("  → sanity-check timestamps above against ground truth before trusting accuracy claims.")
    else:
        print("no effect — keep CUT_STYLE_REF_FPS=0")
        print(
            "  → V2/V3 matched V1's token count and answer (or errored): LiteLLM is not "
            "forwarding video_metadata. Do not add an fps setting."
        )


async def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python scripts/probe_gemini_fps.py <clip.mp4>")
        sys.exit(1)
    clip = Path(sys.argv[1])
    if not clip.exists():
        print(f"ERROR: file not found: {clip}")
        sys.exit(1)

    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs, sync_llm_env
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file

    sync_llm_env()
    import litellm

    litellm.suppress_debug_info = True

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"
    base_kwargs = call_kwargs(model=model, effort=None)
    # Thinking is irrelevant here and only adds latency/output tokens.
    base_kwargs.pop("reasoning_effort", None)
    base_kwargs["timeout"] = int(settings.dub_vision_timeout_sec)
    print(f"Model: {model}")

    truth = _ground_truth(clip)

    print(f"\nUploading {clip.name} via Gemini Files API…")
    t_upload = time.monotonic()
    file_id = await upload_gemini_file(clip, mime_type="video/mp4")
    print(f"Upload done in {round(time.monotonic() - t_upload, 1)}s  file_id={file_id}")

    baseline_block = gemini_video_block(file_id)
    # V2: same shape as gemini_video_block, fps metadata injected inside "file"
    # (built manually on purpose — files.py stays untouched until the probe passes).
    fps_block: dict[str, Any] = {
        "type": "file",
        "file": {
            "file_id": file_id,
            "format": "video/mp4",
            "video_metadata": {"fps": PROBE_FPS},
        },
    }
    text_block = {"type": "text", "text": PROMPT}

    results: list[dict[str, Any]] = []
    try:
        results.append(
            await _run_variant(
                "V1", "baseline (default ~1 fps sampling)",
                [text_block, baseline_block], base_kwargs,
            )
        )
        results.append(
            await _run_variant(
                "V2", f'per-block "video_metadata": {{"fps": {PROBE_FPS}}} inside the file dict',
                [text_block, fps_block], base_kwargs,
            )
        )
        results.append(
            await _run_variant(
                "V3", f"top-level video_metadata={{'fps': {PROBE_FPS}}} kwarg to acompletion",
                [text_block, baseline_block], base_kwargs,
                extra_kwargs={"video_metadata": {"fps": PROBE_FPS}},
            )
        )
    finally:
        await delete_gemini_files([file_id])
        print("\nGemini Files API cleanup done")

    _print_verdict(truth, results)


if __name__ == "__main__":
    asyncio.run(main())
