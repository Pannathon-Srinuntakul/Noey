"""Gemini per-clip video review over Whisper transcripts (hybrid, not a swap).

Whisper owns timing (it does real forced word-alignment). Gemini WATCHES the same
clip's actual video (not just audio — see whisper_client._review_clip_video) and:
(1) corrects mis-heard Thai words / brand names against what is actually said and
    shown, (2) classifies each segment as keep / stutter / repeat / semantic-repeat /
    dead-air so bad takes get cut, and (3) decides keep/cut for candidate silence
    gaps (build_silence_gap_candidates in timeline.py) — a silent stretch can still
    be worth keeping if something visually important happens in it (e.g. a wordless
    product reveal).

Timestamps are NEVER taken from Gemini. The response schema has no timestamp
fields at all, so the model has nothing to anchor a fabricated time to — the merge
step (apply_refine_results) re-reads Whisper's original start/end/words by segment
id, and re-reads the candidate gap's own in/out by gap id, regardless of what
Gemini returns. A timestamp hallucination is therefore structurally impossible,
not merely discouraged by prompt wording. (Segment start/end ARE included in the
*request* sent to Gemini — it needs that to know where in the video to look — but
nothing it returns can carry a time back out.)

This module is pure (no model, no I/O) so the request-shaping and merge logic is
unit-testable. whisper_client._review_clip_video wires this around the actual
LiteLLM/Gemini Files-API call.
"""

from __future__ import annotations

from typing import Any

from packages.video.transcribe import _THAI_AFFILIATE_PROMPT

# Segment classification Gemini must pick per id. Only "keep" survives the merge;
# every cut_* value drops the segment (same effect as is_hallucinated_segment()).
KEEP_ACTION = "keep"
CUT_ACTIONS = ("cut_stutter", "cut_repeat", "cut_semantic_repeat", "cut_dead_air")
REFINE_ACTIONS = (KEEP_ACTION, *CUT_ACTIONS)


def build_refine_request(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reduce Whisper segments to ``[{"id", "start", "end", "text"}, ...]`` for the prompt.

    start/end are included so Gemini (watching the whole clip in one call) knows
    WHERE in the video to look for each segment — this is read-only input context,
    not something it can echo back: the response schema has no timestamp fields,
    so nothing here can round-trip into a fabricated output time. The id is the
    segment's position in ``segments`` so :func:`apply_refine_results` can map the
    reply straight back.
    """
    return [
        {
            "id": i,
            "start": round(float(seg.get("start", 0.0)), 2),
            "end": round(float(seg.get("end", 0.0)), 2),
            "text": str(seg.get("text", "")).strip(),
        }
        for i, seg in enumerate(segments)
    ]


def build_silence_gap_request(gaps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Candidate silence gaps (from build_silence_gap_candidates) → prompt items.

    Same read-only-timing rule as segments: Gemini sees each gap's real in/out so
    it knows which stretch of video to judge, but the response schema only lets it
    reply {"id", "keep"} — no way to smuggle a different time back out.
    """
    return [{"id": g["id"], "start": g["in"], "end": g["out"]} for g in gaps]


# JSON schema handed to Gemini via ``response_format``. No start/end fields exist
# anywhere in it, so structured-output validation itself rejects any timestamp the
# model might try to smuggle in.
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
        },
        "silence_gaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "keep": {"type": "boolean"},
                    "start_pct": {"type": "number"},
                    "end_pct": {"type": "number"},
                },
                "required": ["id", "keep", "start_pct", "end_pct"],
            },
        },
    },
    "required": ["results", "silence_gaps"],
}


# English instructions + Thai examples (matches the house prompt style in
# plan_core.py / dub_ai.py). The correction TARGET language is Thai.
TALKING_REVIEW_SYSTEM = """You are a meticulous Thai-language editor reviewing ONE raw talking-head clip \
for a TikTok affiliate creator, alongside a transcript an automatic speech-to-text model (Whisper) already \
produced from the SAME clip.

You are given THREE things:
1. The real VIDEO of the clip (watch it — image AND audio both matter).
2. A JSON list of SEGMENTS Whisper produced. Each has an integer "id", the "start"/"end" seconds Whisper \
timed it at (read-only reference — you cannot change timing), and the "text" Whisper thought it heard.
3. A JSON list of candidate SILENCE GAPS — stretches between segments with no detected speech. Each has an \
integer "id" and the "start"/"end" seconds of that stretch.

TASK 1 — For EACH segment id, correct the text and classify it:
- Compare Whisper's "text" against what is actually spoken at that timestamp in the video, and return the \
corrected Thai text (fix mis-heard words, wrong spelling, garbled output — a faithful, verbatim transcript \
of what is actually said; do NOT translate, paraphrase, summarize, censor, or add/remove words the speaker \
did not actually say).
- Spell affiliate/e-commerce vocabulary correctly. Terms common in these clips include: {vocab}
- Classify with an "action":
  - "keep"               → clean, usable speech. Keep it.
  - "cut_stutter"        → stammering, a false start, or meaningless filler ("เอ่อ", "อ่า", "เอิ่ม") with no real content.
  - "cut_repeat"         → a redundant re-take repeating the same WORDS as a neighbouring segment.
  - "cut_semantic_repeat"→ a redundant re-take of the same POINT in DIFFERENT words (e.g. the creator re-records \
a line, phrasing it differently the second time) — you can tell because you watch/hear the whole clip, not just \
one isolated segment. When several segments repeat the same point, mark every one EXCEPT the best delivery as \
cut_semantic_repeat (clearest, most confident, most complete take survives as "keep").
  - "cut_dead_air"       → silence, background noise, breathing, or music with no real speech (Whisper hallucinated \
words here).

TASK 2 — For EACH silence gap id, decide "keep" (true) or cut (false), and WHICH PART of it to keep:
- Default to keep=false. A silence gap is cut unless it clearly earns its place — do NOT keep a gap just because \
something is technically visible in it (the creator existing on camera is not a reason). You do not need to keep \
every gap, or even most of them — most silent stretches in a talking-head clip are genuinely dead time (the \
creator pausing, thinking, adjusting, waiting) and belong cut, full stop.
- keep=true ONLY when something you'd actually miss if it were cut happens during that stretch — a real product \
reveal, an on-body demo action, a meaningful reaction or gesture that carries information the narration alone \
doesn't. If you are not confident it adds something, cut it.
- BE STINGY, not generous: this is a TikTok edit — every kept second must earn its place. Never keep a gap in \
full (or nearly in full) just because "something happens somewhere in it". Find the SHORTEST window that still \
captures the key moment (usually 1-3 seconds is enough — a product reveal or gesture reads instantly, it does not \
need room to breathe). Keeping a wide margin around the interesting bit is a mistake, not a safe choice.
- start_pct/end_pct: the fraction (0.0 to 1.0) of the gap's OWN span that is actually worth keeping — 0.0 is the \
very start of the gap, 1.0 is the very end. Only use start_pct=0.0 and end_pct=1.0 when the ENTIRE gap is already \
short and tight (roughly ≤2 seconds) — anything longer, narrow start_pct/end_pct down to the tightest window around \
the actual moment, even if that means keeping only a small fraction of a long gap. When keep=false, start_pct/end_pct \
are ignored — still fill them with 0.0/1.0.

{brief_block}

HARD RULES (follow exactly):
1. NEVER output a timestamp of any kind, for segments or gaps. Return only the fields the schema allows. Timing \
is owned by the system, not by you.
2. Return exactly ONE result for EVERY input segment id, and exactly ONE decision for EVERY input gap id — do not \
skip, merge, split, add, or reorder ids.
3. Keep each "id" identical to the input. Do not renumber.
4. Output STRICT JSON matching the required schema and nothing else — no markdown, no commentary.

Example —
Input segments:
[{{"id": 0, "start": 0.0, "end": 2.1, "text": "สวัดดีค่ะ วันนี้จะมาีวิวสิ้นค้า"}}, {{"id": 1, "start": 2.1, "end": 2.6, "text": "เอ่อ เอ่อ"}}]
Input silence_gaps:
[{{"id": 0, "start": 8.4, "end": 10.1}}, {{"id": 1, "start": 20.0, "end": 80.0}}]
Correct output (gap 0 is short, worth keeping in full; gap 1 is a long 60s stretch where only a ~5s product \
reveal in the middle matters — narrow to that window):
{{"results": [{{"id": 0, "text": "สวัสดีค่ะ วันนี้จะมารีวิวสินค้า", "action": "keep"}}, {{"id": 1, "text": "เอ่อ เอ่อ", "action": "cut_stutter"}}], "silence_gaps": [{{"id": 0, "keep": true, "start_pct": 0.0, "end_pct": 1.0}}, {{"id": 1, "keep": true, "start_pct": 0.45, "end_pct": 0.53}}]}}
"""


def build_talking_review_user_text(
    *,
    segments: list[dict[str, Any]],
    gaps: list[dict[str, Any]],
    brief: str,
) -> str:
    """Assemble the per-call text block sent alongside the clip's video."""
    import json

    brief_block = (
        f"<creator_context>{brief}</creator_context>" if brief.strip() else ""
    )
    system = TALKING_REVIEW_SYSTEM.format(vocab=_THAI_AFFILIATE_PROMPT, brief_block=brief_block)
    segments_json = json.dumps(build_refine_request(segments), ensure_ascii=False)
    gaps_json = json.dumps(build_silence_gap_request(gaps), ensure_ascii=False)
    return (
        f"{system}\n\n"
        f"<segments>\n{segments_json}\n</segments>\n\n"
        f"<silence_gaps>\n{gaps_json}\n</silence_gaps>\n\n"
        "Return ONLY the JSON object described above."
    )


def redistribute_text_over_slots(text: str, slots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tokenize Gemini's corrected ``text`` into real words and spread them
    evenly across the segment's own time span (``slots[0].start`` to
    ``slots[-1].end``) — used to carry the correction down into per-word
    caption timing without ever touching the segment's overall timestamps.

    MUST split on real word boundaries, not raw character counts: an earlier
    version sliced ``text`` by character position proportional to each
    original word's length, which cut mid-syllable whenever the slice
    boundary landed inside a word (e.g. "หัว" → "หั" + "ว") — invisible in
    the segment's own display text, but very visible once those slices
    became separate "words" a caption line groups/wraps on, cutting captions
    off mid-syllable at the wrap point. Real tokenization (pythainlp, same
    engine :func:`packages.video.transcribe.merge_graphemes_to_words` already
    depends on) guarantees every output "word" is a real word.
    """
    text = text.strip()
    if not slots or not text:
        return []

    start = float(slots[0]["start"])
    end = float(slots[-1]["end"])
    if end <= start:
        end = start + 0.01 * max(1, len(text))

    try:
        from pythainlp.tokenize import word_tokenize  # type: ignore[import-untyped]

        real_words = [w for w in word_tokenize(text, engine="newmm", keep_whitespace=False) if w.strip()]
    except ImportError:
        real_words = text.split()
    if not real_words:
        real_words = [text]

    n = len(real_words)
    step = (end - start) / n
    return [
        {"word": w, "start": round(start + i * step, 3), "end": round(start + (i + 1) * step, 3)}
        for i, w in enumerate(real_words)
    ]


def apply_refine_results(
    segments: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge Gemini's ``{id, text, action}`` replies back onto Whisper segments.

    Timing is sacred: every ``start``/``end`` (segment-level AND per-word) comes
    straight from ``segments``, never from ``results`` (any start/end key a
    result smuggles in is ignored — we never read it). For each original
    segment (iterated in order, id = index):

    - action == "keep"           → keep it; replace the display ``text`` with
      Gemini's corrected text when non-empty, and redistribute that corrected
      text over the segment's existing per-word time slots (see
      :func:`redistribute_text_over_slots`) so burned-in word-level captions
      show Gemini's correction too, not just the SRT/manifest text — while
      every timestamp stays exactly Whisper's.
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
            continue  # stutter / repeat / semantic-repeat / dead-air → cut
        # Any non-keep, non-cut value is treated conservatively as "keep".
        new_text = str(hit.get("text") or "").strip()
        if new_text:
            original_words = seg.get("words") or []
            new_words = (
                redistribute_text_over_slots(new_text, original_words)
                if original_words
                else []
            )
            # Timing (start/end) is the dict spread's original value, untouched;
            # only text and the per-word breakdown change.
            out.append({**seg, "text": new_text, "words": new_words or original_words})
        else:
            out.append(seg)
    return out


def apply_silence_gap_results(
    gaps: list[dict[str, Any]],
    silence_gap_results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge Gemini's ``{id, keep, start_pct, end_pct}`` replies onto candidate gaps.

    Timing is sacred here too: a kept gap's in/out are always computed from the
    gap's OWN real ``in``/``out`` (built by build_silence_gap_candidates), never
    from an absolute time in the model's reply — the schema has no start/end
    field for silence_gaps, only fractions (0.0-1.0) of the gap's own span. Those
    fractions are clamped to [0, 1] before use, so the result can never land
    outside the real candidate window no matter what the model returns.

    A long gap where only part matters (e.g. a 5s product reveal inside a 60s
    silence) gets trimmed to just that window instead of dragging in the whole
    dead stretch. No matching/malformed reply for a gap id → conservatively
    dropped (safe default is the original code-only behavior of cutting it).
    """
    by_id: dict[int, dict[str, Any]] = {}
    for r in silence_gap_results:
        if not isinstance(r, dict) or "id" not in r:
            continue
        try:
            by_id[int(r["id"])] = r
        except (TypeError, ValueError):
            continue

    out: list[dict[str, Any]] = []
    for g in gaps:
        hit = by_id.get(int(g["id"]))
        if hit is None or not bool(hit.get("keep")):
            continue
        gap_in, gap_out = float(g["in"]), float(g["out"])
        span = gap_out - gap_in
        try:
            start_pct = min(max(float(hit.get("start_pct", 0.0)), 0.0), 1.0)
        except (TypeError, ValueError):
            start_pct = 0.0
        try:
            end_pct = min(max(float(hit.get("end_pct", 1.0)), 0.0), 1.0)
        except (TypeError, ValueError):
            end_pct = 1.0
        if end_pct <= start_pct:
            start_pct, end_pct = 0.0, 1.0  # malformed range → fall back to the whole gap
        out.append({
            **g,
            "in": round(gap_in + start_pct * span, 3),
            "out": round(gap_in + end_pct * span, 3),
        })
    return out
