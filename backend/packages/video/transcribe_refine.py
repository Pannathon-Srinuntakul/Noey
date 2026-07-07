"""Gemini "refine pass" over Whisper transcripts (hybrid, not a swap).

Whisper owns timing (it does real forced word-alignment). Gemini listens to the
SAME audio and (1) corrects mis-heard Thai words / brand names against what is
actually said, and (2) classifies each segment as keep / stutter / repeat /
dead-air so bad takes get cut.

Timestamps are NEVER taken from Gemini. The request carries no timestamps and
the response schema has no timestamp fields, so the model has nothing to anchor
a fabricated time to; the merge step (`apply_refine_results`) re-reads Whisper's
original ``start``/``end``/``words`` by segment id regardless of what Gemini
returns. A timestamp hallucination is therefore structurally impossible, not
merely discouraged by prompt wording.

This module is pure (no model, no I/O) so the request-shaping and merge logic is
unit-testable. ``whisper_client.refine_via_gemini`` wires these around the actual
LiteLLM/Gemini call.
"""

from __future__ import annotations

import json
from typing import Any

from packages.video.transcribe import _THAI_AFFILIATE_PROMPT

# Segment classification Gemini must pick per id. Only "keep" survives the merge;
# every cut_* value drops the segment (same effect as is_hallucinated_segment()).
KEEP_ACTION = "keep"
CUT_ACTIONS = ("cut_stutter", "cut_repeat", "cut_dead_air")
REFINE_ACTIONS = (KEEP_ACTION, *CUT_ACTIONS)


def build_refine_request(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reduce Whisper segments to ``[{"id": index, "text": ...}]`` for the prompt.

    Deliberately omits ``start``/``end``/``words`` — the model gets nothing to
    anchor a fabricated timestamp to, and the id is the segment's position in
    ``segments`` so :func:`apply_refine_results` can map the reply straight back.
    """
    return [
        {"id": i, "text": str(seg.get("text", "")).strip()}
        for i, seg in enumerate(segments)
    ]


def batch_segment_indices(
    segments: list[dict[str, Any]],
    max_span_sec: float,
) -> list[tuple[int, int]]:
    """Group consecutive segments into ``[start, end)`` index ranges whose audio
    span stays under ``max_span_sec``.

    Used so each Gemini refine call ships an audio slice small enough to stay
    under the inline-audio request limit. A single segment longer than the cap
    still forms its own (oversized) batch rather than being dropped.
    """
    ranges: list[tuple[int, int]] = []
    n = len(segments)
    i = 0
    while i < n:
        span_start = float(segments[i].get("start", 0.0))
        j = i + 1
        while j < n:
            seg_end = float(segments[j].get("end", segments[j].get("start", 0.0)))
            if seg_end - span_start > max_span_sec:
                break
            j += 1
        ranges.append((i, j))
        i = j
    return ranges


# JSON schema handed to Gemini via ``response_format``. No start/end fields
# exist, so structured-output validation itself rejects any timestamp the model
# might try to smuggle in.
GEMINI_REFINE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "text": {"type": "string"},
                    "action": {"type": "string", "enum": list(REFINE_ACTIONS)},
                },
                "required": ["id", "text", "action"],
            },
        }
    },
    "required": ["results"],
}


# English instructions + Thai examples (matches the house prompt style in
# plan_core.py / dub_ai.py). The correction TARGET language is Thai.
_REFINE_PROMPT_TEMPLATE = """You are a meticulous Thai-language transcript proofreader for a TikTok affiliate creator's short video.

You are given TWO things:
1. The real AUDIO of one clip.
2. A JSON list of SEGMENTS that an automatic speech-to-text model (Whisper) already produced from that exact same audio. Each segment has an integer "id" and the "text" Whisper thought it heard.

Whisper times words well but frequently MIS-HEARS Thai words, brand names, and affiliate jargon. Your job is to LISTEN to the audio and fix its mistakes.

For EACH segment id, do two things.

TASK 1 — Correct the text:
- Compare Whisper's "text" against what is actually spoken in the audio at that moment, and return the corrected Thai text.
- Fix mis-heard words, wrong spellings, and garbled output so the text matches the audio exactly (a faithful, verbatim Thai transcript).
- Spell affiliate / e-commerce vocabulary correctly. Terms common in these clips include: {vocab}
- Do NOT translate, paraphrase, summarize, censor, or add/remove words the speaker did not actually say. Correct only.
- Keep the language as spoken (Thai, or mixed Thai-English when that is what is actually said).

TASK 2 — Classify the segment with an "action":
- "keep"         → clean, usable speech. Keep it.
- "cut_stutter"  → stammering, a false start, or meaningless filler ("เอ่อ", "อ่า", "เอิ่ม") carrying no real content.
- "cut_repeat"   → a redundant re-take that repeats the same idea as a neighbouring segment (creator re-recording a line).
- "cut_dead_air" → silence, background noise, breathing, or music with no real speech.

HARD RULES (follow exactly):
1. NEVER output a timestamp of any kind. Return only "id", "text", and "action". Timing is owned by the system, not by you.
2. Return exactly ONE result for EVERY input id — do not skip, merge, split, add, or reorder ids.
3. Keep each "id" identical to the input. Do not renumber.
4. Output STRICT JSON matching the required schema and nothing else — no markdown, no commentary.

Example —
Input segments:
[{{"id": 0, "text": "สวัดดีค่ะ วันนี้จะมาีวิวสิ้นค้า"}}, {{"id": 1, "text": "เอ่อ เอ่อ"}}]
Correct output:
{{"results": [{{"id": 0, "text": "สวัสดีค่ะ วันนี้จะมารีวิวสินค้า", "action": "keep"}}, {{"id": 1, "text": "เอ่อ เอ่อ", "action": "cut_stutter"}}]}}

Here are the segments Whisper produced for this clip:
{segments_json}
"""


def build_refine_prompt(request_items: list[dict[str, Any]]) -> str:
    """Fill the prompt template with the affiliate vocab + the segment list JSON."""
    segments_json = json.dumps(request_items, ensure_ascii=False)
    return _REFINE_PROMPT_TEMPLATE.format(
        vocab=_THAI_AFFILIATE_PROMPT,
        segments_json=segments_json,
    )


def apply_refine_results(
    segments: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge Gemini's ``{id, text, action}`` replies back onto Whisper segments.

    Timing is sacred: ``start``/``end``/``words`` come straight from ``segments``,
    never from ``results`` (any start/end key a result smuggles in is ignored —
    we never read it). For each original segment (iterated in order, id = index):

    - action == "keep"           → keep it; replace the display ``text`` with
      Gemini's corrected text when non-empty (timing untouched).
    - action in the cut_* set     → drop the segment.
    - no matching / malformed reply → keep the segment exactly as Whisper
      produced it (never silently lose audio on a model glitch).
    """
    by_id: dict[int, dict[str, Any]] = {}
    for r in results:
        if not isinstance(r, dict) or "id" not in r:
            continue
        try:
            by_id[int(r["id"])] = r
        except (TypeError, ValueError):
            continue

    out: list[dict[str, Any]] = []
    for i, seg in enumerate(segments):
        hit = by_id.get(i)
        if hit is None:
            out.append(seg)  # model didn't rule on it → keep as-is
            continue
        action = str(hit.get("action") or KEEP_ACTION)
        if action in CUT_ACTIONS:
            continue  # stutter / repeat / dead-air → cut
        # Any non-keep, non-cut value is treated conservatively as "keep".
        new_text = str(hit.get("text") or "").strip()
        if new_text:
            # ONLY the display text changes. The dict spread copies every
            # original timing field (start/end/words) untouched — Gemini's
            # reply cannot influence timing.
            out.append({**seg, "text": new_text})
        else:
            out.append(seg)
    return out
