"""Talking-head planning core — shared by the worker task and the local-render API.

Extracted from ``services/worker/tasks.py`` so the desktop app's local-render flow
reuses the exact same behavior, with geometry supplied as parameters instead of
read from disk.

Content decisions (keep/cut, hallucination/filler/repeat classification, which
silence gaps matter) are made once, per clip, by Gemini watching that clip's real
video — see ``whisper_client.run_transcription`` / ``transcribe_refine.py``. By
the time ``segments``/``silence_gaps`` reach :func:`build_talking_head_timeline`
those decisions are already final; this module only assembles cuts from them and
applies mechanical (non-judgment) cleanup — no Claude/Haiku, no hardcoded
filler/repeat/silence heuristics.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger
from packages.video.timeline import (
    EDITORIAL_BLOCK_GAP,
    build_captions_for_cuts,
    build_clip_boundaries,
    build_speech_cuts,
    cuts_duration,
    filter_short_cuts,
    localize_cuts,
    remove_overlapping_cuts,
    resnap_selected_cuts,
)

log = get_logger(__name__)

ProgressFn = Callable[[str], Awaitable[None]]  # (thai_message)


async def build_talking_head_timeline(
    segments: list[dict[str, Any]],
    *,
    duration_mode: str | None,
    target_duration_sec: int | None,
    clip_durations: list[float],
    source_info: dict[str, Any],
    sources: list[dict[str, Any]],
    silence_gaps: list[dict[str, Any]] | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """Transcript segments → talking_head timeline dict (same schema as plan_edit).

    ``duration_mode``/``target_duration_sec`` are accepted only for backward
    compatibility with existing DB rows (legacy values like "custom"/"auto") —
    there is only one behavior now, so both are ignored.

    ``silence_gaps`` (from ``run_transcription``, already Gemini-reviewed) are
    silent spans between speech segments worth keeping — e.g. a wordless
    product-reveal beat. They are merged in as their own cuts alongside the
    speech cuts before mechanical cleanup.
    """

    async def _progress(msg: str) -> None:
        if on_progress:
            await on_progress(msg)

    boundaries = build_clip_boundaries(clip_durations)
    total_duration = boundaries[-1]["end"] if boundaries else 0.0

    speech_cuts = build_speech_cuts(
        segments,
        gap_threshold=EDITORIAL_BLOCK_GAP,
        source_duration=total_duration,
    )
    if not speech_cuts:
        raise ValueError("Transcript has no speech segments to keep")

    await _progress("กำลังประกอบไทม์ไลน์…")
    cuts = list(speech_cuts)
    if silence_gaps:
        gap_cuts = [
            {"type": "cut", "source": "clip0", "in": g["in"], "out": g["out"], "label": "silence"}
            for g in silence_gaps
        ]
        cuts = sorted(cuts + gap_cuts, key=lambda c: float(c["in"]))

    cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
    cuts = filter_short_cuts(cuts)
    cuts = remove_overlapping_cuts(cuts)
    log.info("cuts_ready", count=len(cuts), duration=round(cuts_duration(cuts), 1))
    if not cuts:
        raise ValueError("No speech segments remain after removing clips shorter than 1 second")

    render_cuts = filter_short_cuts(localize_cuts(cuts, boundaries))
    kept_sec = cuts_duration(render_cuts)

    captions = build_captions_for_cuts(segments, cuts)

    # talking_head = silence-cut + keep speech (+ Gemini-approved silent beats).
    # No overlays/effects here — popups, stickers, zoom, burned captions belong
    # to richer modes (future work).
    return {
        "mode": "talking_head",
        "editMode": "full",
        "sources": sources,
        "timeline": render_cuts,
        "captions": captions,
        "output": {
            **source_info,
            "targetDurationSec": None,
            "maxDurationSec": round(kept_sec, 1),
            "sourceDurationSec": round(total_duration, 1),
            "clipCount": len(clip_durations),
        },
    }
