"""Talking-head planning core — shared by the worker task and the local-render API.

Extracted from ``services/worker/tasks.py`` so the desktop app's local-render flow
reuses the exact same behavior, with geometry supplied as parameters instead of
read from disk.

Content decisions are settled upstream in ``elevenlabs_stt.run_transcription``:
Scribe removes fillers and false starts itself (``no_verbatim``), low-confidence
tokens are dropped by log-probability, and the silent spans worth keeping are the
ones carrying a tagged audio event. By the time ``segments``/``silence_gaps``
reach :func:`build_talking_head_timeline` those decisions are final; this module
only assembles cuts from them and applies mechanical (non-judgment) cleanup — no
LLM calls of any kind.
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
        # A clip with no speech at all (music-only b-roll, ambient footage) is
        # a real thing users try in ตัดช่วงเงียบ — the mode has nothing to keep
        # because "keep the talking" is its entire definition. Say that in the
        # user's own words + the way out, instead of an English exception.
        raise ValueError(
            "คลิปนี้ไม่มีเสียงพูดให้ตัด — โหมดตัดช่วงเงียบเก็บเฉพาะช่วงที่มีคนพูด "
            "ถ้าเป็นคลิปไม่มีเสียงพูด ให้ใช้โหมดตัดฉากเด่นแทน"
        )

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
        raise ValueError(
            "ช่วงที่มีเสียงพูดสั้นเกินไปทุกช่วง (ต่ำกว่า 1 วินาที) เลยไม่เหลืออะไรให้ตัด — "
            "ลองใช้โหมดตัดฉากเด่น หรือใช้คลิปที่พูดต่อเนื่องกว่านี้"
        )

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
