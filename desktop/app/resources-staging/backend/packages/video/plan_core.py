"""Talking-head planning core — shared by the worker task and the local-render API.

Extracted verbatim from ``services/worker/tasks.py`` (transcript cleanup, Haiku
highlight selection, semantic dedupe, and the full timeline-building pipeline)
so the desktop app's local-render flow can reuse the exact same behavior with
geometry supplied as parameters instead of read from disk.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger
from packages.video.timeline import (
    AI_SEMANTIC_DEDUPE_SYSTEM,
    EDITORIAL_BLOCK_GAP,
    HIGHLIGHT_HAIKU_SYSTEM,
    _text_for_cut,
    apply_semantic_dedupe_plan,
    build_captions_for_cuts,
    build_clip_boundaries,
    build_speech_blocks,
    build_speech_cuts,
    cut_duration,
    cuts_duration,
    dedupe_repeated_cuts,
    dedupe_spaced_word_repeats,
    enforce_cuts_budget,
    filter_short_cuts,
    localize_cuts,
    parse_llm_json,
    remove_overlapping_cuts,
    resnap_selected_cuts,
    select_speech_cuts_by_ids,
    split_cuts_on_internal_silence,
    strip_filler_cuts,
    strip_filler_words_from_cuts,
    trim_speech_cuts_to_budget,
    whisper_segments_for_cut,
)

log = get_logger(__name__)

ProgressFn = Callable[[str], Awaitable[None]]  # (thai_message)


async def clean_transcript_with_llm(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fix Thai spelling/spacing in transcript text without touching timestamps.

    Whisper fine-tuned on Thai often outputs run-together or misspelled words.
    Haiku corrects text only; all timing data is preserved.
    """
    from packages.llm.gateway import complete

    all_text = " ".join(s.get("text", "") for s in segments).strip()
    if len(all_text) < 50 or not segments:
        return segments

    entries = [{"i": i, "t": s.get("text", "")} for i, s in enumerate(segments)]
    prompt = (
        "<transcript>\n"
        f"{json.dumps(entries, ensure_ascii=False)}\n"
        "</transcript>\n\n"
        "<instruction>Fix Thai spelling and word spacing in each 't' field. "
        "Do NOT change meaning, add words, or alter timing. "
        "Return JSON array with same structure: [{\"i\": ..., \"t\": \"corrected text\"}, ...]"
        "</instruction>"
    )
    try:
        raw = await complete(prompt, system="You are a Thai text editor. Fix only spelling and spacing.")
        parsed = parse_llm_json(raw)
        if isinstance(parsed, list):
            corrected = {entry["i"]: entry["t"] for entry in parsed if "i" in entry and "t" in entry}
            out = []
            for i, seg in enumerate(segments):
                if i in corrected:
                    out.append({**seg, "text": corrected[i]})
                else:
                    out.append(seg)
            log.info("transcript_cleaned", segments=len(out))
            return out
    except Exception as exc:
        log.warning("transcript_clean_failed", error=str(exc))
    return segments


async def plan_highlight_with_haiku(
    speech_cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    target_sec: int,
) -> list[dict[str, Any]]:
    """Haiku text-only: select speech blocks to fit target_sec budget.

    No vision frames, no Sonnet — purely block-id selection by transcript text.
    Falls back to trim_speech_cuts_to_budget on any error.
    """
    from packages.llm.gateway import complete

    blocks = build_speech_blocks(speech_cuts, segments)
    if not blocks:
        return trim_speech_cuts_to_budget(speech_cuts, float(target_sec))

    total_natural = sum(float(b.get("duration", 0)) for b in blocks)
    prompt = (
        f"<budget>\n"
        f"<targetSec>{target_sec}</targetSec>\n"
        f"<totalIfAllKeptSec>{round(total_natural, 1)}</totalIfAllKeptSec>\n"
        f"</budget>\n\n"
        f"<speech_blocks>\n{json.dumps(blocks, ensure_ascii=False)}\n</speech_blocks>\n\n"
        "<instruction>Select blocks to keep within the budget. "
        "Return JSON: {\"keep\": [0, 2, 4], \"remove_reason\": {\"1\": \"filler\"}}</instruction>"
    )
    try:
        raw = await complete(prompt, system=HIGHLIGHT_HAIKU_SYSTEM)
        parsed = parse_llm_json(raw)
        keep_ids: list[int] = [int(i) for i in (parsed.get("keep") or []) if 0 <= int(i) < len(blocks)]
        if keep_ids:
            kept = select_speech_cuts_by_ids(speech_cuts, keep_ids, blocks)
            if kept:
                log.info("haiku_highlight_ok", kept=len(kept), removed=len(blocks) - len(keep_ids), target_sec=target_sec)
                return kept
        log.warning("haiku_highlight_empty_fallback", keep_ids=keep_ids)
    except Exception as exc:
        log.warning("haiku_highlight_failed", error=str(exc))

    return trim_speech_cuts_to_budget(speech_cuts, float(target_sec))


async def dedupe_semantic_cuts_with_llm(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Haiku pass: drop repeated takes when meaning matches but Whisper wording differs."""
    from packages.llm.gateway import complete

    entries: list[dict[str, Any]] = []
    for i, cut in enumerate(cuts):
        text = _text_for_cut(cut, segments).strip()
        whisper_segs = whisper_segments_for_cut(cut, segments)
        if not text and not whisper_segs:
            continue
        entries.append({
            "cut_index": i,
            "text": text[:400],
            "whisper_segments": whisper_segs[:12],
            "duration_sec": round(cut_duration(cut), 1),
        })
    if len(entries) < 2:
        return cuts

    prompt = (
        "<cuts_to_review>\n"
        f"{json.dumps(entries, ensure_ascii=False)}\n"
        "</cuts_to_review>\n\n"
        "<instruction>Find repeated takes (same meaning, different Whisper wording). "
        "Return duplicate_groups JSON only.</instruction>"
    )
    try:
        raw = await complete(prompt, system=AI_SEMANTIC_DEDUPE_SYSTEM)
        parsed = parse_llm_json(raw)
        deduped = apply_semantic_dedupe_plan(cuts, segments, parsed)
        removed = len(cuts) - len(deduped)
        if removed:
            log.info("semantic_dedupe_done", removed=removed, kept=len(deduped))
        return deduped
    except Exception as exc:
        log.warning("semantic_dedupe_failed", error=str(exc))
        return cuts


async def build_talking_head_timeline(
    segments: list[dict[str, Any]],
    *,
    duration_mode: str | None,
    target_duration_sec: int | None,
    clip_durations: list[float],
    source_info: dict[str, Any],
    sources: list[dict[str, Any]],
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """Transcript segments → talking_head timeline dict (same schema as plan_edit).

    Callers pass clip geometry explicitly (worker reads it from normalized
    files; the local-render API reads it from ``local_meta``). Segments should
    already be transcript-cleaned via :func:`clean_transcript_with_llm`.
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

    speech_cuts = dedupe_repeated_cuts(speech_cuts, segments)

    target_sec = target_duration_sec

    # full mode — code only, no AI
    if duration_mode == "full" or duration_mode is None:
        edit_mode = "full"
        target_sec = None
        cuts = list(speech_cuts)
        await _progress("ตัดช่วงเงียบ + ลบคำพูดซ้ำ…")
        cuts = strip_filler_cuts(cuts, segments)
        cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
        cuts = strip_filler_words_from_cuts(cuts, segments)
        cuts = dedupe_spaced_word_repeats(cuts, segments)
        cuts = dedupe_repeated_cuts(cuts, segments)
        cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
        cuts = filter_short_cuts(cuts)

    # custom mode — Haiku text-only highlight planning
    elif duration_mode == "custom" and target_sec is not None:
        edit_mode = "highlight"
        await _progress(f"Haiku กำลังเลือก highlight ให้พอดี {target_sec} วิ…")
        cuts = await plan_highlight_with_haiku(speech_cuts, segments, target_sec)
        # Semantic dedupe — removes duplicate takes at block level
        if len(cuts) >= 2:
            cuts = await dedupe_semantic_cuts_with_llm(cuts, segments)
        cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
        cuts = strip_filler_words_from_cuts(cuts, segments)
        cuts = dedupe_spaced_word_repeats(cuts, segments)
        cuts = dedupe_repeated_cuts(cuts, segments)
        before_budget = cuts_duration(cuts)
        cuts = enforce_cuts_budget(cuts, segments, float(target_sec))
        after_budget = cuts_duration(cuts)
        if after_budget < before_budget - 0.5:
            log.info(
                "cuts_budget_enforced",
                target_sec=target_sec,
                before_sec=round(before_budget, 1),
                after_sec=round(after_budget, 1),
            )
        cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
        cuts = filter_short_cuts(cuts)

    else:
        # Fallback for unexpected mode — treat as full
        edit_mode = "full"
        target_sec = None
        cuts = list(speech_cuts)
        cuts = strip_filler_cuts(cuts, segments)
        cuts = split_cuts_on_internal_silence(cuts, segments, source_duration=total_duration)
        cuts = strip_filler_words_from_cuts(cuts, segments)
        cuts = dedupe_spaced_word_repeats(cuts, segments)
        cuts = dedupe_repeated_cuts(cuts, segments)
        cuts = resnap_selected_cuts(cuts, segments, source_duration=total_duration)
        cuts = filter_short_cuts(cuts)

    cuts = remove_overlapping_cuts(cuts)
    log.info("cuts_after_dedup", count=len(cuts), duration=round(cuts_duration(cuts), 1))
    if not cuts:
        raise ValueError("No speech segments remain after removing clips shorter than 1 second")

    render_cuts = filter_short_cuts(localize_cuts(cuts, boundaries))
    kept_sec = cuts_duration(render_cuts)

    captions = build_captions_for_cuts(segments, cuts)

    # talking_head = silence-cut + keep speech only. No overlays/effects here —
    # popups, stickers, zoom and burned captions belong to richer modes (future work).
    return {
        "mode": "talking_head",
        "editMode": edit_mode,
        "sources": sources,
        "timeline": render_cuts,
        "captions": captions,
        "output": {
            **source_info,
            "targetDurationSec": target_sec,
            "maxDurationSec": round(kept_sec, 1),
            "sourceDurationSec": round(total_duration, 1),
            "clipCount": len(clip_durations),
        },
    }
