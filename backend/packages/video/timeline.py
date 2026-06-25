"""Build edit timelines from Whisper transcript."""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from typing import Any

# Merge consecutive Whisper segments with gap ≤ this into one cut.
# Word-level gap threshold is no longer used for splitting — Thai Whisper splits
# text into individual characters whose timestamps can have large internal gaps
# (e.g. "ป"→"ั" gap > 0.8s inside "ปัน"), causing spurious mid-word cuts.
# 2.5s: used by resnap forward-look to re-absorb adjacent segments into a selected
# cut's tail — handles the gap inflation caused by tighten_segment_bounds (~0.5s).
SEGMENT_MERGE_GAP = 2.5   # resnap forward-look threshold — must stay > WORD_TAIL + JOIN_LEAD_IN
# Gap used when building editorial blocks for Claude's block-selection.
# Smaller than SEGMENT_MERGE_GAP so Claude sees individual sentences (not one giant block)
# and can selectively remove boring/filler sentences.  resnap will re-join adjacent
# kept sentences that fall within SEGMENT_MERGE_GAP anyway.
EDITORIAL_BLOCK_GAP = 1.0
# Kept for callers passing it as an arg; no longer the primary cut boundary.
WORD_GAP_THRESHOLD = 0.35
# VAD speech_pad_ms≈350 pre-rolls segment.start before detected speech.
# INVARIANT: WORD_TAIL + JOIN_LEAD_IN < SEGMENT_MERGE_GAP
WORD_LEAD_IN = 0.20
OPENING_LEAD_IN = 0.30   # first clip in output timeline
JOIN_LEAD_IN = 0.50      # every cut after editorial jump (AI removed silence before)
HEAD_LOOKBACK_SEC = 0.35 # scan for early phonemes Whisper placed just before segment.start
WORD_TAIL = 0.75         # Thai phoneme + tone decay after last word timestamp (opening / default)
JOIN_TAIL = 1.0          # middle join cuts — longer tail after jump-cut splice
CONCLUSION_TAIL = 1.0    # more tail for final sentence (was 0.80)
# INVARIANT: JOIN_LEAD_IN + JOIN_TAIL (1.50) < SEGMENT_MERGE_GAP (2.50) ✓
# Single-token spans longer than this are usually Whisper timing glitches, not speech.
MAX_WORD_DUR = 1.8
MIN_WORD_DUR = 0.04
# ffmpeg trim/atrim often fails below ~1 frame, especially at clip EOF.
MIN_RENDER_CUT_SEC = 0.10
# Editorial floor — segments shorter than this are not worth keeping in the final edit.
MIN_KEEP_CUT_SEC = 1.0
# Standalone hesitation tokens removed when a kept block contains nothing else.
# Conservative list — only unambiguous fillers (avoids cutting real Thai particles).
FILLER_TOKENS = frozenset({
    # Thai hesitations
    "เอ่อ", "เอิ่ม", "อ่า", "อ้า", "เอ้อ", "เออ", "อืม", "อึม", "หืม", "อ่ะ",
    # English hesitations
    "um", "umm", "uh", "uhh", "uhm", "er", "err", "erm", "hmm", "hm",
    "mm", "mmm", "ah", "ahh", "eh", "ehh",
})
# Drop repeated takes when normalized text is this similar (0–1).
DUPLICATE_SIMILARITY = 0.85
# Shorter phrase must reach this fraction of the longer one when it is a substring.
DUPLICATE_SUBSTRING_RATIO = 0.65
# Same word spoken again after this gap (sec) = false start / retake — drop later cuts.
REPEAT_WORD_GAP_SEC = 1.0
# Same phrase (multi-word cut) spoken again after this gap — drop later cut.
REPEAT_PHRASE_GAP_SEC = 0.5

# Heuristics for orphan-continuation detection (after AI removes a prior block).
THAI_CONTINUATION_PREFIXES = (
    "แล้ว", "ก็", "แต่", "เพราะ", "เมื่อ", "ถ้า", "และ", "หรือ",
    "จาก", "โดย", "ซึ่ง", "ที่", "ให้", "จน", "กับ", "ยัง", "อีก",
    "ต่อ", "ตาม", "เพื่อ", "จึง", "เลย", "ด้วย", "คือ", "ว่า", "ทำ",
)
THAI_STANDALONE_OPENERS = (
    "วันนี้", "ตอนนี้", "สวัสดี", "สวัสดีค่ะ", "สวัสดีครับ",
    "มา", "มาดู", "มารีวิว", "เปิด", "โอเค", "แนะนำ", "โชว์", "ลอง",
    "ทุกคน", "เพื่อน", "ก่อน", "รีวิว", "ขอ", "เฮ้ย", "โอ้", "ว้าว",
)
THAI_CONTINUATION_PHRASES = (
    "ตัวนี้", "อันนี้", "นี่", "นี้", "แบบนี้", "อย่างนี้", "แบบนั้น",
    "ตัวนั้น", "อันนั้น", "ของมัน", "ของเรา", "ของเธอ", "ด้วยนะ",
)
THAI_SENTENCE_END_PARTICLES = (
    "ครับ", "ค่ะ", "คะ", "นะ", "นะคะ", "นะครับ", "จ้า", "จ๊ะ", "เลย",
)
# Gaps shorter than this between blocks may still be one utterance split by VAD.
CONTINUATION_MAX_GAP_SEC = 2.5
# Within one kept cut, pause longer than this → jump-cut (skip dead air, TikTok pacing).
MAX_INTERNAL_SILENCE_SEC = 1.0

HIGHLIGHT_HAIKU_SYSTEM = """<role>
You are a TikTok video editor for a Thai affiliate creator.
</role>

<task>
Select speech blocks to keep within a target duration budget.
You receive speech blocks with transcript text and timestamps.
Return which block IDs to keep — prioritise content-rich, engaging delivery.
</task>

<rules>
<budget>Total kept duration MUST NOT exceed the targetSec given in the user message.</budget>
<selection>
- Pick the most engaging blocks: hook, product demo, benefit highlights, conclusion/CTA
- Remove repeated takes (same point said again), pure filler (ums, false starts), prep chatter
- When in doubt between two similar blocks, keep the cleaner/more confident delivery
</selection>
<continuity>
- If you remove block N, also remove block N+1 if it only continues that same sentence (mid-sentence fragment)
- Prefer keeping a complete thought over a partial one
</continuity>
</rules>

<forbidden>
Do NOT output prose, markdown, or any text outside the JSON object.
Do NOT invent block IDs — use only the indices from the speech_blocks list provided.
</forbidden>

<output_format>
Return ONLY a valid JSON object:
{"keep": [0, 2, 4], "remove_reason": {"1": "filler", "3": "repeated take"}}
</output_format>"""

AI_SEMANTIC_DEDUPE_SYSTEM = """<role>
You are an expert TikTok video editor reviewing a rough cut transcript.
</role>

<task>
Identify cuts that are REPEATED TAKES of the same spoken content — same meaning and intent —
even when Whisper transcribed them with different words, spelling, or sentence structure.
</task>

<rules>
- Compare MEANING, not exact text: paraphrases, false starts redone, and re-recorded lines count as duplicates
- Each cut includes whisper_segments — read ALL snippets; Whisper often transcribes the same Thai line with different spelling or word order
- Example duplicates: "วันนี้มารีวิวครีมตัวนี้" vs "วันนี้จะมารีวิวครีมนี้ให้ดู"; "ส่วนผสมดีมาก" vs "ส่วนประกอบดีเลย"
- Thai affiliate content often repeats product name, benefits, or demo steps across takes — keep only ONE best take per repeated point
- Do NOT mark cuts as duplicates if they cover genuinely different product features, demo steps, or story beats
- When a group duplicates, the cut with the clearest complete delivery should stay (usually longer, more confident phrasing)
- visual_broll / silent cuts (empty text) are never duplicates of speech
</rules>

<forbidden>
Do NOT output prose or markdown — JSON only.
</forbidden>

<output_format>
Return ONLY a valid JSON object:
{
  "duplicate_groups": [
    {"keep": 0, "remove": [3], "reason": "same product intro, take 2"},
    {"keep": 1, "remove": [5], "reason": "repeated demo step, different wording"}
  ]
}
Each group lists cut_index values from the input. "keep" is the best take; "remove" are redundant repeats.
If no duplicates found, return {"duplicate_groups": []}.
</output_format>"""

BEAT_TRIM_PREFER_END = frozenset({"cta", "conclusion"})


def cuts_duration(cuts: list[dict[str, Any]]) -> float:
    return sum(float(c["out"]) - float(c["in"]) for c in cuts)


def cut_duration(cut: dict[str, Any]) -> float:
    return float(cut["out"]) - float(cut["in"])


def filter_short_cuts(
    cuts: list[dict[str, Any]],
    *,
    min_sec: float = MIN_KEEP_CUT_SEC,
) -> list[dict[str, Any]]:
    """Drop cuts shorter than min_sec."""
    return [c for c in cuts if cut_duration(c) >= min_sec]


def remove_overlapping_cuts(cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trim cuts that overlap a previous one — never drop the whole later cut.

    Sorts by start time. When cut B starts before cut A ends, advance B.in to A.out
    (50ms tolerance). Drop B only if the trimmed range is too short to keep.
    """
    if not cuts:
        return cuts
    sorted_cuts = sorted(cuts, key=lambda c: float(c["in"]))
    result: list[dict[str, Any]] = []
    last_end = -1.0
    for cut in sorted_cuts:
        c_in = float(cut["in"])
        c_out = float(cut["out"])
        if c_in < last_end - 0.05:
            c_in = last_end
            if c_out - c_in < MIN_KEEP_CUT_SEC:
                continue
            cut = {**cut, "in": round(c_in, 3)}
        result.append(cut)
        last_end = float(cut["out"])
    if result:
        _relabel_opening_conclusion(result)
    return result


def filter_renderable_cuts(cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop cuts too short to keep or encode (plan + render safety net)."""
    return filter_short_cuts(cuts, min_sec=max(MIN_RENDER_CUT_SEC, MIN_KEEP_CUT_SEC))


def parse_llm_json(raw: str) -> dict[str, Any]:
    """Parse JSON from LLM output (markdown fences, preamble, trailing text)."""
    text = raw.strip()
    if text.startswith("```"):
        # Single-line fence: ```json { ... } ```
        if "\n" not in text:
            text = text[3:].lstrip()
            if text.lower().startswith("json"):
                text = text[4:].lstrip()
            if text.endswith("```"):
                text = text[:-3].strip()
        else:
            lines = text.split("\n")
            text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            text = text.strip()
            if text.lower().startswith("json"):
                text = text[4:].lstrip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Brace-scan fallback — Haiku sometimes wraps JSON with prose or truncates fences.
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in LLM response")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("unclosed JSON object in LLM response")


def build_clip_boundaries(durations: list[float]) -> list[dict[str, Any]]:
    """Map combined transcript time to per-upload-clip ranges."""
    boundaries: list[dict[str, Any]] = []
    offset = 0.0
    for i, raw_dur in enumerate(durations):
        dur = max(0.0, float(raw_dur))
        boundaries.append({
            "id": f"clip{i}",
            "start": round(offset, 3),
            "end": round(offset + dur, 3),
            "duration": round(dur, 3),
        })
        offset += dur
    return boundaries


def split_global_cut(
    global_in: float,
    global_out: float,
    boundaries: list[dict[str, Any]],
    *,
    label: str = "speech",
) -> list[dict[str, Any]]:
    """Split one combined-timeline cut into per-source cuts."""
    cuts: list[dict[str, Any]] = []
    g_in, g_out = float(global_in), float(global_out)
    if g_out <= g_in:
        return cuts
    for b in boundaries:
        seg_in = max(g_in, float(b["start"]))
        seg_out = min(g_out, float(b["end"]))
        if seg_out <= seg_in:
            continue
        local_in = seg_in - float(b["start"])
        local_out = min(seg_out - float(b["start"]), float(b["duration"]))
        if local_out <= local_in:
            continue
        cuts.append({
            "type": "cut",
            "source": b["id"],
            "in": round(local_in, 3),
            "out": round(local_out, 3),
            "label": label,
        })
    return cuts


def localize_cuts(
    cuts: list[dict[str, Any]],
    boundaries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Map combined-timeline in/out to per-clip local times for render."""
    if not boundaries:
        return cuts
    if len(boundaries) == 1:
        b = boundaries[0]
        localized: list[dict[str, Any]] = []
        for c in cuts:
            cut_in = max(0.0, float(c["in"]) - float(b["start"]))
            cut_out = min(float(c["out"]) - float(b["start"]), float(b["duration"]))
            if cut_out <= cut_in:
                continue
            localized.append({
                "type": "cut",
                "source": b["id"],
                "in": round(cut_in, 3),
                "out": round(cut_out, 3),
                "label": c.get("label", "speech"),
            })
        return localized

    out: list[dict[str, Any]] = []
    for c in cuts:
        out.extend(split_global_cut(
            float(c["in"]),
            float(c["out"]),
            boundaries,
            label=str(c.get("label", "speech")),
        ))
    return out


def _repair_segment_words(seg: dict[str, Any]) -> list[tuple[float, float]]:
    """Fix zero-duration words and extend ends toward the next word / segment boundary."""
    seg_start, seg_end = float(seg["start"]), float(seg["end"])
    raw_words = seg.get("words") or []
    parsed: list[tuple[float, float]] = []

    for w in raw_words:
        token = str(w.get("word", "")).strip()
        if not token or not re.search(r"[\w\u0E00-\u0E7F]", token, flags=re.UNICODE):
            continue
        ws, we = float(w["start"]), float(w["end"])
        parsed.append((ws, we))

    if not parsed:
        text = str(seg.get("text", "")).strip()
        if text and seg_end > seg_start:
            return [(seg_start, seg_end)]
        return []

    repaired: list[tuple[float, float]] = []
    for i, (ws, we) in enumerate(parsed):
        if we <= ws:
            if i + 1 < len(parsed):
                we = max(ws + MIN_WORD_DUR, parsed[i + 1][0] - 0.02)
            else:
                we = max(ws + MIN_WORD_DUR, seg_end)
        if i + 1 < len(parsed):
            nxt = parsed[i + 1][0]
            if nxt > we:
                we = min(nxt - 0.02, we + 0.20)
        else:
            we = max(we, seg_end)
        we = max(we, ws + MIN_WORD_DUR)
        if we - ws > MAX_WORD_DUR:
            we = ws + MAX_WORD_DUR
        repaired.append((ws, we))

    return repaired


def _collect_words(
    segments: list[dict[str, Any]],
    *,
    exclude_fillers: bool = False,
) -> list[tuple[float, float]]:
    """Flatten word timestamps; fall back to segment bounds if words missing."""
    words: list[tuple[float, float]] = []
    for seg in segments:
        raw_words = seg.get("words") or []
        if raw_words:
            for w in raw_words:
                token = str(w.get("word", "")).strip()
                if not token:
                    continue
                norm = _normalize_speech_text(token)
                if exclude_fillers and norm in FILLER_TOKENS:
                    continue
                ws, we = float(w["start"]), float(w["end"])
                if we > ws:
                    words.append((ws, we))
            continue
        words.extend(_repair_segment_words(seg))
    words.sort(key=lambda x: x[0])
    return words


def _snap_to_words(
    start: float,
    end: float,
    words: list[tuple[float, float]],
    *,
    is_opening: bool,
    is_conclusion: bool,
    join_cut: bool = False,
) -> tuple[float, float]:
    """Snap cut edges to spoken-word boundaries with editor-style padding."""
    if not words:
        return start, end

    overlapping = [(ws, we) for ws, we in words if we > start and ws < end]
    if not overlapping:
        overlapping = [(ws, we) for ws, we in words if ws >= start - 0.5 and ws <= end + 0.5]
    if not overlapping:
        return start, end

    first_w = min(ws for ws, _ in overlapping)
    last_w = max(we for _, we in overlapping)
    if is_opening:
        lead = OPENING_LEAD_IN
    elif join_cut:
        lead = JOIN_LEAD_IN
    else:
        lead = WORD_LEAD_IN
    if is_conclusion:
        tail = CONCLUSION_TAIL
    elif join_cut:
        tail = JOIN_TAIL
    else:
        tail = WORD_TAIL

    head_anchor = min(start, first_w)
    # Whisper often places the first grapheme late — pull head back if words start
    # just before the segment boundary.
    early = [(ws, we) for ws, we in words if ws >= start - HEAD_LOOKBACK_SEC and ws < start + 0.05]
    if early:
        head_anchor = min(head_anchor, min(ws for ws, _ in early))

    # Tail: trust VAD segment end when it extends past last word (tone decay).
    tail_anchor = max(last_w, end)
    trailing = [(ws, we) for ws, we in words if ws >= end - 0.05 and ws <= end + tail]
    if trailing:
        tail_anchor = max(tail_anchor, max(we for _, we in trailing))

    return max(0.0, head_anchor - lead), tail_anchor + tail


def build_speech_cuts(
    segments: list[dict[str, Any]],
    *,
    source_id: str = "clip0",
    gap_threshold: float = SEGMENT_MERGE_GAP,
    source_duration: float | None = None,
) -> list[dict[str, Any]]:
    """Build keep-ranges from Whisper segment boundaries.

    Works at segment level, not word level.  Thai Whisper outputs individual
    grapheme-cluster tokens whose timestamps can have large inter-character gaps
    (e.g. 'ป'→'ั' = 0.88 s inside the same word), which the old word-level
    splitter mistook for silence and cut mid-word.  A Whisper segment is already
    a coherent speech unit — never split inside one.

    Adjacent segments whose gap ≤ gap_threshold are merged into one cut.
    Word timestamps are still used for precise edge snapping.
    """
    valid = [s for s in segments if float(s.get("end", 0)) > float(s.get("start", 0))]
    if not valid:
        return []

    all_words = _collect_words(valid)

    # Merge consecutive segments with small gaps.
    seg_blocks: list[list[float]] = [[float(valid[0]["start"]), float(valid[0]["end"])]]
    for seg in valid[1:]:
        s, e = float(seg["start"]), float(seg["end"])
        if s - seg_blocks[-1][1] <= gap_threshold:
            seg_blocks[-1][1] = e
        else:
            seg_blocks.append([s, e])

    cuts: list[dict[str, Any]] = []
    last_idx = len(seg_blocks) - 1
    for i, (start, end) in enumerate(seg_blocks):
        # Drop Whisper hallucinations before snap — padding would inflate sub-second noise past MIN_KEEP.
        if (end - start) < MIN_KEEP_CUT_SEC:
            continue
        is_opening = i == 0
        is_conclusion = i == last_idx
        cut_in, cut_out = _snap_to_words(
            start, end, all_words, is_opening=is_opening, is_conclusion=is_conclusion,
        )
        if source_duration is not None:
            cut_out = min(cut_out, source_duration)
        if cut_out <= cut_in or (cut_out - cut_in) < MIN_KEEP_CUT_SEC:
            continue
        label = "opening" if is_opening else ("conclusion" if is_conclusion else "speech")
        cuts.append({
            "type": "cut",
            "source": source_id,
            "in": round(cut_in, 3),
            "out": round(cut_out, 3),
            "label": label,
        })
    return cuts


def _normalize_speech_text(text: str) -> str:
    """Normalize transcript text for duplicate-take comparison."""
    cleaned = re.sub(r"[^\w\s\u0E00-\u0E7F]", "", text, flags=re.UNICODE)
    cleaned = re.sub(r"\s+", "", cleaned)
    return cleaned.casefold()


def _text_for_cut(cut: dict[str, Any], segments: list[dict[str, Any]]) -> str:
    """Collect spoken words/text overlapping a cut range."""
    cut_in, cut_out = float(cut["in"]), float(cut["out"])
    parts: list[str] = []
    for seg in segments:
        seg_start, seg_end = float(seg["start"]), float(seg["end"])
        if seg_end <= cut_in or seg_start >= cut_out:
            continue
        raw_words = seg.get("words") or []
        if raw_words:
            for w in raw_words:
                ws, we = float(w["start"]), float(w["end"])
                if we > cut_in and ws < cut_out:
                    token = str(w.get("word", "")).strip()
                    if token:
                        parts.append(token)
        else:
            token = str(seg.get("text", "")).strip()
            if token:
                parts.append(token)
    return " ".join(parts)


def _take_score(cut: dict[str, Any], segments: list[dict[str, Any]]) -> float:
    """Prefer the most complete, well-paced take when text repeats."""
    text = _normalize_speech_text(_text_for_cut(cut, segments))
    if not text:
        return 0.0
    dur = cut_duration(cut)
    score = float(len(text) * 10)
    if dur > 0:
        pace = len(text) / dur
        if 3.0 <= pace <= 30.0:
            score += 5.0
    return score


def _is_duplicate_text(a: str, b: str, *, similarity: float) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if shorter in longer and len(shorter) / len(longer) >= DUPLICATE_SUBSTRING_RATIO:
        return True
    if SequenceMatcher(None, a, b).ratio() >= similarity:
        return True
    prefix = 0
    for ca, cb in zip(a, b, strict=False):
        if ca != cb:
            break
        prefix += 1
    min_len = min(len(a), len(b))
    return min_len > 0 and prefix / min_len >= 0.8


def _relabel_opening_conclusion(cuts: list[dict[str, Any]]) -> None:
    if not cuts:
        return
    for cut in cuts:
        if cut.get("label") in ("opening", "conclusion", "hook", "highlight"):
            cut["label"] = "speech"
    cuts[0]["label"] = "opening"
    cuts[-1]["label"] = "conclusion"


def dedupe_repeated_cuts(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    similarity: float = DUPLICATE_SIMILARITY,
    gap_sec: float = REPEAT_PHRASE_GAP_SEC,
) -> list[dict[str, Any]]:
    """Drop spaced phrase retakes — words joined from cut range, compared cut-to-cut.

    Single-word cuts are skipped here (handled by dedupe_spaced_word_repeats @ 1s).
    Multi-word cuts: same/similar text with gap > gap_sec (default 0.5s) → keep latest,
    drop the earlier take. gap <= gap_sec → keep both (intentional emphasis).
    """
    if len(cuts) < 2:
        return cuts

    kept: list[dict[str, Any]] = []
    for cut in sorted(cuts, key=lambda c: float(c["in"])):
        if _is_broll_cut(cut):
            kept.append(cut)
            continue

        text = _normalize_speech_text(_text_for_cut(cut, segments))
        if not text:
            kept.append(cut)
            continue

        tokens = _words_for_cut(cut, segments)
        if len(tokens) == 1:
            kept.append(cut)
            continue

        replace_idx: int | None = None
        for i, prev in enumerate(kept):
            prev_text = _normalize_speech_text(_text_for_cut(prev, segments))
            if not prev_text or len(_words_for_cut(prev, segments)) == 1:
                continue
            if not _is_duplicate_text(text, prev_text, similarity=similarity):
                continue
            gap = float(cut["in"]) - float(prev["out"])
            if gap > gap_sec:
                replace_idx = i
                break

        if replace_idx is not None:
            kept.pop(replace_idx)
        kept.append(cut)

    if not kept:
        return cuts
    kept.sort(key=lambda c: float(c["in"]))
    _relabel_opening_conclusion(kept)
    return kept


def _words_for_cut(
    cut: dict[str, Any],
    segments: list[dict[str, Any]],
) -> list[tuple[str, float, float]]:
    """Normalized word tokens with timestamps overlapping a cut."""
    cut_in, cut_out = float(cut["in"]), float(cut["out"])
    out: list[tuple[str, float, float]] = []
    for seg in segments:
        raw_words = seg.get("words") or []
        if raw_words:
            for w in raw_words:
                ws, we = float(w["start"]), float(w["end"])
                if we <= cut_in or ws >= cut_out:
                    continue
                token = str(w.get("word", "")).strip()
                if not token:
                    continue
                norm = _normalize_speech_text(token)
                if norm:
                    out.append((norm, ws, we))
        elif float(seg.get("end", 0)) > cut_in and float(seg.get("start", 0)) < cut_out:
            for token in str(seg.get("text", "")).split():
                norm = _normalize_speech_text(token)
                if norm:
                    s, e = float(seg["start"]), float(seg["end"])
                    out.append((norm, s, e))
    out.sort(key=lambda t: t[1])
    return out


def dedupe_spaced_word_repeats(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    gap_sec: float = REPEAT_WORD_GAP_SEC,
) -> list[dict[str, Any]]:
    """Drop earlier single-word retakes when the same word is spoken again >gap_sec later.

    Keeps the latest take. Consecutive repeats (gap <= gap_sec) are kept — emphasis.
    """
    if len(cuts) < 2:
        return cuts

    kept: list[dict[str, Any]] = []

    for cut in sorted(cuts, key=lambda c: float(c["in"])):
        if _is_broll_cut(cut):
            kept.append(cut)
            continue

        tokens = _words_for_cut(cut, segments)
        if not tokens:
            kept.append(cut)
            continue

        if len(tokens) == 1:
            norm, ws, we = tokens[0]
            for i in range(len(kept) - 1, -1, -1):
                prev = kept[i]
                if _is_broll_cut(prev):
                    continue
                prev_tokens = _words_for_cut(prev, segments)
                if len(prev_tokens) != 1 or prev_tokens[0][0] != norm:
                    continue
                prev_end = prev_tokens[0][2]
                if ws - prev_end > gap_sec:
                    kept.pop(i)
                break
            kept.append(cut)
            continue

        kept.append(cut)

    if not kept:
        return cuts
    kept.sort(key=lambda c: float(c["in"]))
    _relabel_opening_conclusion(kept)
    return kept


def _is_broll_cut(cut: dict[str, Any]) -> bool:
    """True for explicit visual/broll cuts (no speech to split)."""
    label = str(cut.get("label", "")).lower()
    return label in {"visual", "product_closeup", "broll"} or "visual" in label


def _is_visual_only_cut(cut: dict[str, Any], segments: list[dict[str, Any]]) -> bool:
    """True for broll/silent cuts with no meaningful speech in range."""
    if _is_broll_cut(cut):
        return True
    text = _normalize_speech_text(_text_for_cut(cut, segments))
    return not text


def whisper_segments_for_cut(
    cut: dict[str, Any],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Ordered Whisper snippets inside a cut — for semantic duplicate review."""
    segs = _segments_in_range(segments, float(cut["in"]), float(cut["out"]))
    out: list[dict[str, Any]] = []
    for seg in segs:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        out.append({
            "start": round(float(seg["start"]), 2),
            "end": round(float(seg["end"]), 2),
            "text": text[:200],
        })
    return out


def apply_semantic_dedupe_plan(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    parsed: dict[str, Any],
) -> list[dict[str, Any]]:
    """Apply Haiku semantic duplicate groups — keep best take per repeated meaning."""
    if not cuts:
        return cuts
    remove_indices: set[int] = set()
    for group in parsed.get("duplicate_groups") or []:
        if not isinstance(group, dict):
            continue
        keep_idx = group.get("keep")
        remove_list = group.get("remove") or []
        if keep_idx is None:
            continue
        keep_i = int(keep_idx)
        if not (0 <= keep_i < len(cuts)):
            continue
        for raw in remove_list:
            ri = int(raw)
            if 0 <= ri < len(cuts) and ri != keep_i:
                remove_indices.add(ri)
    if not remove_indices:
        return cuts
    kept = [c for i, c in enumerate(cuts) if i not in remove_indices]
    if not kept:
        return cuts
    _relabel_opening_conclusion(kept)
    return kept


def _word_gap_subspans(
    words: list[tuple[float, float]],
    span_in: float,
    span_out: float,
    max_gap_sec: float,
) -> list[tuple[float, float]]:
    """Split a [span_in, span_out] range at word gaps longer than max_gap_sec."""
    sub = [(ws, we) for ws, we in words if we > span_in and ws < span_out]
    if not sub:
        return [(span_in, span_out)]
    groups: list[list[tuple[float, float]]] = [[sub[0]]]
    for ws, we in sub[1:]:
        if ws - groups[-1][-1][1] <= max_gap_sec:
            groups[-1].append((ws, we))
        else:
            groups.append([(ws, we)])
    return [
        (max(g[0][0], span_in), min(g[-1][1], span_out))
        for g in groups
    ]


def split_cuts_on_internal_silence(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    max_gap_sec: float = MAX_INTERNAL_SILENCE_SEC,
    source_duration: float | None = None,
) -> list[dict[str, Any]]:
    """Split cuts when Whisper segments inside have pauses longer than max_gap_sec."""
    if not cuts:
        return cuts
    words = _collect_words(segments)
    out: list[dict[str, Any]] = []

    for cut in cuts:
        if _is_broll_cut(cut):
            out.append(cut)
            continue

        cut_in, cut_out = float(cut["in"]), float(cut["out"])
        segs = _segments_in_range(segments, cut_in, cut_out)

        # When a single long segment covers the cut, fall back to word-level gap detection
        if len(segs) < 2:
            cut_words = [(ws, we) for ws, we in words if we > cut_in and ws < cut_out]
            word_groups: list[list[tuple[float, float]]] = []
            if cut_words:
                word_groups = [[cut_words[0]]]
                for ws, we in cut_words[1:]:
                    gap = ws - word_groups[-1][-1][1]
                    if gap <= max_gap_sec:
                        word_groups[-1].append((ws, we))
                    else:
                        word_groups.append([(ws, we)])
            if len(word_groups) < 2:
                out.append(cut)
                continue
            for gi, grp in enumerate(word_groups):
                g_in = max(grp[0][0], cut_in)
                g_out = min(grp[-1][1], cut_out)
                if g_out - g_in < MIN_KEEP_CUT_SEC:
                    continue
                out.append({**cut, "in": round(g_in, 3), "out": round(g_out, 3)})
            continue

        groups: list[list[dict[str, Any]]] = [[segs[0]]]
        for seg in segs[1:]:
            gap = float(seg["start"]) - float(groups[-1][-1]["end"])
            if gap <= max_gap_sec:
                groups[-1].append(seg)
            else:
                groups.append([seg])

        # Expand each segment-group into word-gap subspans so a large pause
        # *inside* a single Whisper segment also splits (defensive backstop for
        # segments that slipped past transcribe-time word-gap splitting).
        spans: list[tuple[float, float]] = []
        for group in groups:
            g_in = max(float(group[0]["start"]), cut_in)
            g_out = min(float(group[-1]["end"]), cut_out)
            spans.extend(_word_gap_subspans(words, g_in, g_out, max_gap_sec))

        if len(spans) <= 1:
            out.append(cut)
            continue

        for si, (s_in, s_out) in enumerate(spans):
            is_first = si == 0
            is_last = si == len(spans) - 1
            snap_in, snap_out = _snap_to_words(
                s_in,
                s_out,
                words,
                is_opening=is_first and cut.get("label") == "opening",
                is_conclusion=is_last and cut.get("label") == "conclusion",
                join_cut=not is_first,
            )
            if source_duration is not None:
                snap_out = min(snap_out, source_duration)
            if snap_out <= snap_in or (snap_out - snap_in) < MIN_KEEP_CUT_SEC:
                continue
            out.append({
                **cut,
                "in": round(snap_in, 3),
                "out": round(snap_out, 3),
                "label": cut.get("label", "speech") if is_first else "speech",
            })

    if not out:
        return cuts
    out.sort(key=lambda c: float(c["in"]))
    _relabel_opening_conclusion(out)
    return out


def _is_filler_only(text: str) -> bool:
    """True when every spoken token in the text is a hesitation filler."""
    cleaned = re.sub(r"[^\w\s฀-๿]", " ", text, flags=re.UNICODE)
    tokens = [t.strip("ๆ").casefold() for t in cleaned.split() if t.strip("ๆ")]
    if not tokens:
        return False
    return all(t in FILLER_TOKENS for t in tokens)


def _is_filler_token(norm: str) -> bool:
    return norm in FILLER_TOKENS


def strip_filler_words_from_cuts(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Remove hesitation fillers inside speech cuts (เอ่อ, อืม, um, …).

    Splits a cut around filler tokens using word timestamps. Whole-cut filler
    blocks disappear; mixed speech loses only the filler intervals.
    """
    if not cuts:
        return cuts

    out: list[dict[str, Any]] = []
    for cut in cuts:
        if _is_broll_cut(cut):
            out.append(cut)
            continue

        tokens = _words_for_cut(cut, segments)
        if not tokens:
            out.append(cut)
            continue

        groups: list[list[tuple[str, float, float]]] = []
        current: list[tuple[str, float, float]] = []
        for norm, ws, we in tokens:
            if _is_filler_token(norm):
                if current:
                    groups.append(current)
                    current = []
                continue
            if current and ws - current[-1][2] > MAX_INTERNAL_SILENCE_SEC:
                groups.append(current)
                current = []
            current.append((norm, ws, we))
        if current:
            groups.append(current)

        if not groups:
            continue

        cut_in, cut_out = float(cut["in"]), float(cut["out"])
        for grp in groups:
            g_in = max(cut_in, grp[0][1])
            g_out = min(cut_out, grp[-1][2])
            if g_out - g_in < MIN_KEEP_CUT_SEC:
                continue
            out.append({**cut, "in": round(g_in, 3), "out": round(g_out, 3)})

    if not out:
        return cuts
    out.sort(key=lambda c: float(c["in"]))
    _relabel_opening_conclusion(out)
    return out


def strip_filler_cuts(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Drop kept blocks whose spoken content is pure hesitation ("เอ่อ", "um", …).

    Only removes a cut when its entire overlapping transcript is filler, so real
    speech that merely contains a filler word is never touched. Re-labels the
    surviving opening/conclusion afterwards.
    """
    if not cuts:
        return cuts
    kept = [c for c in cuts if not _is_filler_only(_text_for_cut(c, segments))]
    if not kept:
        # Everything looked like filler — keep originals rather than emptying the edit.
        return cuts
    if len(kept) != len(cuts):
        _relabel_opening_conclusion(kept)
    return kept


def is_likely_continuation(
    prev_text: str,
    text: str,
    *,
    gap_sec: float | None,
) -> bool:
    """True when *text* probably continues *prev_text* rather than opening fresh."""
    if gap_sec is None or gap_sec > CONTINUATION_MAX_GAP_SEC:
        return False
    t = text.strip()
    if not t:
        return False
    norm = _normalize_speech_text(t)
    for opener in THAI_STANDALONE_OPENERS:
        if norm.startswith(_normalize_speech_text(opener)):
            return False
    for prefix in THAI_CONTINUATION_PREFIXES:
        if norm.startswith(_normalize_speech_text(prefix)):
            return True
    for phrase in THAI_CONTINUATION_PHRASES:
        if norm.startswith(_normalize_speech_text(phrase)):
            return True
    prev = _normalize_speech_text(prev_text)
    if not prev:
        return False
    prev_complete = any(
        prev.endswith(_normalize_speech_text(p)) for p in THAI_SENTENCE_END_PARTICLES
    )
    if not prev_complete:
        if gap_sec < 1.5 and len(norm) <= 12:
            return True
        if gap_sec < 1.2 and len(norm) <= 20:
            return True
    return False


def build_speech_blocks(
    speech_cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Map speech cuts → editorial blocks for Claude block-selection."""
    blocks: list[dict[str, Any]] = []
    for i, sc in enumerate(speech_cuts):
        cut_in, cut_out = float(sc["in"]), float(sc["out"])
        block_text = _text_for_cut(sc, segments).strip()
        gap = round(cut_in - float(speech_cuts[i - 1]["out"]), 2) if i > 0 else None
        prev_text = blocks[i - 1]["text"] if i > 0 else ""
        continuation = is_likely_continuation(prev_text, block_text, gap_sec=gap)
        blocks.append({
            "id": i,
            "in": cut_in,
            "out": cut_out,
            "duration": round(cut_out - cut_in, 2),
            "gap_from_prev_sec": gap,
            "likely_continuation": continuation,
            "text": block_text,
        })
    return blocks


def cascade_filter_keep_ids(
    keep_ids: list[int],
    blocks: list[dict[str, Any]],
) -> list[int]:
    """Drop kept blocks that only make sense after a removed predecessor."""
    keep = {int(i) for i in keep_ids if 0 <= int(i) < len(blocks)}
    if not keep:
        return []

    changed = True
    while changed:
        changed = False
        for idx in sorted(list(keep)):
            if idx == 0:
                continue
            prev_idx = idx - 1
            if prev_idx in keep:
                continue
            block = blocks[idx]
            prev_text = blocks[prev_idx].get("text", "")
            gap = block.get("gap_from_prev_sec")
            text = str(block.get("text", ""))
            if block.get("likely_continuation") or is_likely_continuation(
                prev_text, text, gap_sec=gap if isinstance(gap, (int, float)) else None,
            ):
                keep.discard(idx)
                changed = True
    return sorted(keep)


def select_speech_cuts_by_ids(
    speech_cuts: list[dict[str, Any]],
    keep_ids: list[int],
    blocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Apply cascade-safe keep list → speech cut dicts."""
    filtered = cascade_filter_keep_ids(keep_ids, blocks)
    return [speech_cuts[i] for i in filtered if 0 <= i < len(speech_cuts)]




def _segments_in_range(
    segments: list[dict[str, Any]],
    range_in: float,
    range_out: float,
) -> list[dict[str, Any]]:
    return sorted(
        [
            s for s in segments
            if float(s.get("end", 0)) > range_in and float(s.get("start", 0)) < range_out
        ],
        key=lambda s: float(s["start"]),
    )


def trim_range_to_segment_budget(
    segments: list[dict[str, Any]],
    range_in: float,
    range_out: float,
    budget_sec: float,
    *,
    prefer: str = "start",
) -> tuple[float, float]:
    """Trim to complete Whisper segments only — never cut mid-segment."""
    segs = _segments_in_range(segments, range_in, range_out)
    if not segs:
        return range_in, range_out

    clipped: list[tuple[float, float, float]] = []
    for seg in segs:
        s_in = max(float(seg["start"]), range_in)
        s_out = min(float(seg["end"]), range_out)
        if s_out > s_in:
            clipped.append((s_in, s_out, s_out - s_in))

    if not clipped:
        return range_in, range_out

    natural = sum(d for _, _, d in clipped)
    if natural <= budget_sec + 0.05:
        return clipped[0][0], clipped[-1][1]

    order = list(reversed(clipped)) if prefer == "end" else clipped
    picked: list[tuple[float, float, float]] = []
    total = 0.0
    for item in order:
        if total + item[2] <= budget_sec + 0.05:
            picked.append(item)
            total += item[2]
        elif not picked:
            # Never split a segment — keep whole even if over budget.
            picked.append(item)
            break
        else:
            break

    if prefer == "end":
        picked.reverse()
    return picked[0][0], picked[-1][1]






def resnap_selected_cuts(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    source_duration: float | None = None,
) -> list[dict[str, Any]]:
    """Re-snap each kept block after editorial selection with join-aware padding.

    AI block selection removes silence between blocks; surviving blocks need fresh
    in/out edges — especially a generous pre-roll so we don't cut in mid-phoneme.
    """
    if not cuts:
        return cuts

    words = _collect_words(segments, exclude_fillers=True)
    valid = sorted(
        [s for s in segments if float(s.get("end", 0)) > float(s.get("start", 0))],
        key=lambda s: float(s["start"]),
    )
    ordered = sorted(cuts, key=lambda c: float(c["in"]))
    out: list[dict[str, Any]] = []

    for i, cut in enumerate(ordered):
        cut_in, cut_out = float(cut["in"]), float(cut["out"])
        overlap = [
            s for s in valid
            if float(s["end"]) > cut_in and float(s["start"]) < cut_out
        ]
        if not overlap:
            overlap = [
                s for s in valid
                if float(s["start"]) <= cut_in <= float(s["end"])
            ]
        # Use cut's own boundaries as the snap window — not the full segment range.
        # Without this, a 2s cut inside a 62s segment would expand to the full segment.
        seg_start = cut_in
        seg_end = cut_out

        if overlap:
            first = min(overlap, key=lambda s: float(s["start"]))
            last = max(overlap, key=lambda s: float(s["end"]))
            try:
                fi = valid.index(first)
            except ValueError:
                fi = -1
            # Look BACKWARD: previous segment close enough → extend head
            if fi > 0:
                prev = valid[fi - 1]
                if float(first["start"]) - float(prev["end"]) <= SEGMENT_MERGE_GAP:
                    seg_start = min(seg_start, float(prev["start"]))
                    seg_end = max(seg_end, float(prev["end"]))
            # Look FORWARD: next segment(s) within SEGMENT_MERGE_GAP → extend tail.
            # tighten_segment_bounds can move segment ends back ~0.5s, inflating the
            # apparent gap to the next Whisper segment and splitting a continuous
            # sentence across two blocks.  We re-absorb those segments here so the
            # tail of the cut covers the full utterance.
            try:
                li = valid.index(last)
            except ValueError:
                li = -1
            if li >= 0:
                nxt_i = li + 1
                while nxt_i < len(valid):
                    nxt = valid[nxt_i]
                    nxt_start = float(nxt["start"])
                    if nxt_start - seg_end > SEGMENT_MERGE_GAP:
                        break
                    # Only absorb into tail if the next kept cut does NOT claim this segment
                    next_cut_in = float(ordered[i + 1]["in"]) if i + 1 < len(ordered) else float("inf")
                    if nxt_start >= next_cut_in:
                        break
                    seg_end = max(seg_end, float(nxt["end"]))
                    nxt_i += 1

        # Do not absorb speech already covered by the previous kept cut.
        if i > 0 and out:
            floor_in = float(out[-1]["out"])
            seg_start = max(seg_start, floor_in)
            seg_end = max(seg_end, seg_start)

        new_in, new_out = _snap_to_words(
            seg_start,
            seg_end,
            words,
            is_opening=(i == 0),
            is_conclusion=(i == len(ordered) - 1),
            join_cut=(i > 0),
        )
        if source_duration is not None:
            new_out = min(new_out, source_duration)
        if out:
            new_in = max(new_in, float(out[-1]["out"]))
        if new_out <= new_in:
            continue
        out.append({**cut, "in": round(new_in, 3), "out": round(new_out, 3)})

    if out:
        _relabel_opening_conclusion(out)
        return out
    return cuts


def build_captions_for_cuts(
    segments: list[dict[str, Any]],
    cuts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Map transcript segments onto the concatenated output timeline."""
    captions: list[dict[str, Any]] = []
    out_t = 0.0
    seg_i = 0
    segs = sorted(segments, key=lambda s: float(s["start"]))

    for cut in cuts:
        cut_in = float(cut["in"])
        cut_out = float(cut["out"])
        cut_dur = cut_out - cut_in

        while seg_i < len(segs) and float(segs[seg_i]["end"]) <= cut_in:
            seg_i += 1

        j = seg_i
        while j < len(segs) and float(segs[j]["start"]) < cut_out:
            seg = segs[j]
            seg_start = max(float(seg["start"]), cut_in)
            seg_end = min(float(seg["end"]), cut_out)
            if seg_end > seg_start:
                text = str(seg.get("text", "")).strip()
                if text:
                    captions.append({
                        "start": round(out_t + (seg_start - cut_in), 3),
                        "end": round(out_t + (seg_end - cut_in), 3),
                        "text": text,
                        "highlight": False,
                    })
            j += 1

        out_t += cut_dur

    return captions




def _cut_trim_priority(cut: dict[str, Any], index: int, total: int) -> int:
    """Higher = trim or drop this cut before others (protect opening/conclusion)."""
    label = str(cut.get("label", "")).lower()
    btype = str(cut.get("beat_type", label)).lower()
    if index == 0 or label == "opening":
        return 0
    if index == total - 1 or label == "conclusion":
        return 1
    if btype == "hook":
        return 2
    return 3


def enforce_cuts_budget(
    cuts: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    budget_sec: float,
) -> list[dict[str, Any]]:
    """Final pass: total duration must fit budget after resnap padding (segment-safe)."""
    if not cuts:
        return cuts

    ordered = sorted(cuts, key=lambda c: float(c["in"]))
    if cuts_duration(ordered) <= budget_sec + 0.15:
        return ordered

    result = [dict(c) for c in ordered]
    max_iters = max(len(result) * 24, 24)
    for _ in range(max_iters):
        total = cuts_duration(result)
        if total <= budget_sec + 0.15:
            break
        over = total - budget_sec
        n = len(result)

        shrinkable: list[tuple[int, int, float]] = []
        for i, cut in enumerate(result):
            dur = cut_duration(cut)
            if dur <= MIN_KEEP_CUT_SEC + 0.2:
                continue
            shrinkable.append((_cut_trim_priority(cut, i, n), i, dur))

        if not shrinkable:
            break

        shrinkable.sort(key=lambda x: (-x[0], -x[2]))
        pri, idx, dur = shrinkable[0]
        cut = result[idx]
        shave = min(over + 0.05, dur - MIN_KEEP_CUT_SEC)
        if shave < 0.3:
            if pri >= 2 and n > 1:
                result.pop(idx)
                continue
            break

        btype = str(cut.get("beat_type", cut.get("label", "speech"))).lower()
        prefer = "end" if btype in BEAT_TRIM_PREFER_END else "start"
        trim_in, trim_out = trim_range_to_segment_budget(
            segments,
            float(cut["in"]),
            float(cut["out"]),
            dur - shave,
            prefer=prefer,
        )
        trimmed = {**cut, "in": round(trim_in, 3), "out": round(trim_out, 3)}
        if cut_duration(trimmed) >= dur - 0.05:
            if pri >= 2 and n > 1:
                result.pop(idx)
            else:
                break
        else:
            result[idx] = trimmed

    if cuts_duration(result) > budget_sec + 0.15:
        result = trim_speech_cuts_to_budget(result, budget_sec)

    result.sort(key=lambda c: float(c["in"]))
    _relabel_opening_conclusion(result)
    return result


def _trim_cut_to_budget(
    cut: dict[str, Any],
    budget_sec: float,
    *,
    prefer: str = "start",
) -> dict[str, Any]:
    """Slice one speech cut down to budget_sec without crossing the range."""
    cut_in, cut_out = float(cut["in"]), float(cut["out"])
    dur = cut_out - cut_in
    if dur <= budget_sec:
        return cut
    if prefer == "end":
        new_in = cut_out - budget_sec
    elif prefer == "middle":
        mid = (cut_in + cut_out) / 2
        half = budget_sec / 2
        new_in = mid - half
        new_out = mid + half
        return {**cut, "in": round(new_in, 3), "out": round(new_out, 3)}
    else:
        new_in = cut_in
    new_out = new_in + budget_sec
    new_out = min(new_out, cut_out)
    new_in = max(cut_in, new_out - budget_sec)
    return {**cut, "in": round(new_in, 3), "out": round(new_out, 3)}


def trim_speech_cuts_to_budget(
    speech_cuts: list[dict[str, Any]],
    target_duration: float,
) -> list[dict[str, Any]]:
    """Fallback: pick speech blocks spread across the timeline within budget."""
    if not speech_cuts or cuts_duration(speech_cuts) <= target_duration:
        return speech_cuts

    if len(speech_cuts) == 1:
        return [_trim_cut_to_budget(speech_cuts[0], target_duration, prefer="middle")]

    # Always try opening + conclusion; slice oversized blocks instead of skipping them.
    order: list[int] = [0, len(speech_cuts) - 1]
    for i in range(len(speech_cuts)):
        if i not in order:
            order.append(i)

    picked: list[dict[str, Any]] = []
    total = 0.0
    last_idx = len(speech_cuts) - 1
    tail_reserve = 0.0
    if last_idx > 0:
        tail_reserve = min(cut_duration(speech_cuts[last_idx]), max(6.0, target_duration * 0.2))

    for idx in order:
        cut = speech_cuts[idx]
        remaining = target_duration - total
        if remaining < MIN_KEEP_CUT_SEC:
            break
        if idx == 0 and last_idx > 0 and idx != last_idx:
            remaining = max(MIN_KEEP_CUT_SEC, remaining - tail_reserve)
        dur = cut_duration(cut)
        if dur <= remaining:
            picked.append(dict(cut))
            total += dur
            continue
        if idx == 0:
            trimmed = _trim_cut_to_budget(cut, remaining, prefer="start")
        elif idx == len(speech_cuts) - 1:
            trimmed = _trim_cut_to_budget(cut, remaining, prefer="end")
        else:
            trimmed = _trim_cut_to_budget(cut, remaining, prefer="middle")
        if cut_duration(trimmed) >= MIN_KEEP_CUT_SEC:
            picked.append(trimmed)
            total += cut_duration(trimmed)

    picked.sort(key=lambda x: float(x["in"]))
    if picked:
        picked[0]["label"] = "opening"
        picked[-1]["label"] = "conclusion"
    return picked or [_trim_cut_to_budget(speech_cuts[0], target_duration, prefer="start")]


# Dub-first silent preview floor (talking_head keeps MIN_KEEP_CUT_SEC).
DUB_MIN_CUT_SEC = 0.35
# Soft cap: one angle should not linger longer than this when more cuts are possible.
DUB_MAX_HOLD_SEC = 3.5
# When model picks sourceIn far from a sampled frame, snap trim to that frame.
DUB_ANCHOR_TOLERANCE_SEC = 0.35
# Treat sample anchors within this window as the same scene (no reuse).
DUB_FRAME_DEDUPE_TOLERANCE_SEC = 0.5


def _segment_anchor_time(seg: dict[str, Any]) -> float:
    for key in ("matchedFrameTime", "sourceIn"):
        raw = seg.get(key)
        if raw is not None:
            try:
                return float(raw)
            except (TypeError, ValueError):
                pass
    return 0.0


def _resolve_frame_anchor(
    seg: dict[str, Any],
    frames: list[dict[str, Any]],
) -> tuple[str, float, dict[str, Any] | None]:
    clip_id = str(seg.get("sourceClip") or "clip0")
    target_t = _segment_anchor_time(seg)
    nearest = _nearest_sample_frame(frames, clip_id, target_t) if frames else None
    if nearest is not None:
        return clip_id, float(nearest["time"]), nearest
    return clip_id, round(target_t, 1), None


def _frame_dedupe_key(clip_id: str, anchor_t: float) -> tuple[str, float]:
    bucket = round(anchor_t / DUB_FRAME_DEDUPE_TOLERANCE_SEC) * DUB_FRAME_DEDUPE_TOLERANCE_SEC
    return clip_id, round(bucket, 1)


def _apply_frame_to_segment(
    seg: dict[str, Any],
    frame: dict[str, Any],
    *,
    duration_sec: float | None = None,
) -> None:
    dur = duration_sec if duration_sec is not None else _dub_segment_duration(seg)
    if dur <= 0:
        dur = 1.75
    dur = max(dur, DUB_MIN_CUT_SEC)
    anchor = float(frame["time"])
    scene_start = float(frame.get("scene_start", 0))
    scene_end = float(frame.get("scene_end", anchor + dur))
    new_in = max(scene_start, min(anchor, scene_end - dur))
    new_out = min(scene_end, new_in + dur)
    seg["sourceClip"] = str(frame.get("clip_id") or seg.get("sourceClip") or "clip0")
    seg["sourceIn"] = round(new_in, 2)
    seg["sourceOut"] = round(new_out, 2)
    seg["durationSec"] = round(new_out - new_in, 2)
    seg["matchedFrameTime"] = round(anchor, 2)


def enforce_unique_chronological_dub_cuts(
    edit_script: dict[str, Any],
    sample_frames: list[dict[str, Any]],
) -> dict[str, Any]:
    """Drop duplicate scene anchors; keep only AI-selected cuts in source-time order."""
    from packages.core.logging import get_logger

    log = get_logger(__name__)

    segs = [dict(s) for s in (edit_script.get("segments") or []) if isinstance(s, dict)]
    if not segs or not sample_frames:
        return edit_script

    for seg in segs:
        _, _, frame = _resolve_frame_anchor(seg, sample_frames)
        if frame is not None:
            _apply_frame_to_segment(seg, frame)

    segs.sort(key=lambda s: _segment_anchor_time(s))

    used_keys: set[tuple[str, float]] = set()
    kept: list[dict[str, Any]] = []
    dropped = 0

    for seg in segs:
        clip_id, anchor_t, _frame = _resolve_frame_anchor(seg, sample_frames)
        key = _frame_dedupe_key(clip_id, anchor_t)
        if key in used_keys:
            dropped += 1
            continue
        used_keys.add(key)
        kept.append(seg)

    total = sum(_dub_segment_duration(s) for s in kept)
    for i, seg in enumerate(kept, start=1):
        seg["order"] = i

    if dropped:
        log.info(
            "dub_unique_chrono_enforced",
            kept=len(kept),
            dropped=dropped,
            total_sec=round(total, 1),
            sample_frames=len(sample_frames),
        )

    edit_script["segments"] = kept
    return edit_script



def _dub_segment_duration(seg: dict[str, Any]) -> float:
    dur = float(seg.get("durationSec") or 0.0)
    if dur <= 0:
        try:
            dur = max(0.0, float(seg["sourceOut"]) - float(seg["sourceIn"]))
        except (KeyError, TypeError, ValueError):
            dur = 0.0
    return dur


def _nearest_sample_frame(
    frames: list[dict[str, Any]],
    clip_id: str,
    target_t: float,
) -> dict[str, Any] | None:
    clip_frames = [f for f in frames if str(f.get("clip_id") or "clip0") == clip_id]
    if not clip_frames:
        return None
    return min(clip_frames, key=lambda f: abs(float(f["time"]) - target_t))


def anchor_dub_segments_to_frames(
    edit_script: dict[str, Any],
    frames: list[dict[str, Any]],
) -> dict[str, Any]:
    """Snap segment trims to sampled frame timestamps when the model picks a loose window."""
    if not frames:
        return edit_script

    for seg in edit_script.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        clip_id = str(seg.get("sourceClip") or "clip0")
        dur = max(_dub_segment_duration(seg), DUB_MIN_CUT_SEC)

        target_t: float | None = None
        raw_match = seg.get("matchedFrameTime")
        if raw_match is not None:
            try:
                target_t = float(raw_match)
            except (TypeError, ValueError):
                target_t = None
        if target_t is None:
            try:
                target_t = float(seg.get("sourceIn", 0))
            except (TypeError, ValueError):
                continue

        nearest = _nearest_sample_frame(frames, clip_id, target_t)
        if nearest is None:
            continue

        anchor = float(nearest["time"])
        try:
            src_in = float(seg.get("sourceIn", anchor))
        except (TypeError, ValueError):
            src_in = anchor

        if abs(src_in - anchor) <= DUB_ANCHOR_TOLERANCE_SEC and src_in >= anchor - 0.05:
            continue

        scene_start = float(nearest.get("scene_start", 0))
        scene_end = float(nearest.get("scene_end", anchor + dur))
        new_in = max(scene_start, min(anchor, scene_end - dur))
        new_out = min(scene_end, new_in + dur)
        if new_out - new_in < DUB_MIN_CUT_SEC:
            continue

        seg["sourceIn"] = round(new_in, 2)
        seg["sourceOut"] = round(new_out, 2)
        seg["durationSec"] = round(new_out - new_in, 2)
        seg["matchedFrameTime"] = round(anchor, 2)

    return edit_script


def normalize_dub_edit_script(
    edit_script: dict[str, Any],
    *,
    sample_frames: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Normalize dub edit script: durations, voiceoverLineId groups, montage script fill."""
    if sample_frames:
        edit_script = anchor_dub_segments_to_frames(edit_script, sample_frames)
        edit_script = enforce_unique_chronological_dub_cuts(edit_script, sample_frames)

    segs = [s for s in (edit_script.get("segments") or []) if isinstance(s, dict)]
    if not segs:
        return edit_script

    segs.sort(key=lambda s: int(s.get("order") or 0))

    # Sync durationSec from source trim; clamp to dub montage floor.
    for seg in segs:
        try:
            src_dur = max(0.0, float(seg["sourceOut"]) - float(seg["sourceIn"]))
        except (KeyError, TypeError, ValueError):
            src_dur = 0.0
        dur = float(seg.get("durationSec") or 0.0)
        if dur <= 0 and src_dur > 0:
            dur = src_dur
        if dur > 0:
            seg["durationSec"] = round(max(dur, DUB_MIN_CUT_SEC), 2)

    # Assign voiceoverLineId when the model omitted it.
    next_line_id = 1
    prev_script = ""
    prev_line_id: int | None = None
    for seg in segs:
        raw_id = seg.get("voiceoverLineId")
        script = str(seg.get("voiceoverScript") or "").strip()
        if raw_id is not None:
            try:
                line_id = int(raw_id)
            except (TypeError, ValueError):
                line_id = next_line_id
                next_line_id += 1
            else:
                next_line_id = max(next_line_id, line_id + 1)
        elif not script and prev_line_id is not None:
            line_id = prev_line_id
        elif script and script == prev_script and prev_line_id is not None:
            line_id = prev_line_id
        else:
            line_id = next_line_id
            next_line_id += 1
        seg["voiceoverLineId"] = line_id
        if script:
            prev_script = script
            prev_line_id = line_id

    # Fill voiceoverScript on montage continuation cuts from the line's first spoken text.
    line_script: dict[int, str] = {}
    for seg in segs:
        lid = int(seg["voiceoverLineId"])
        script = str(seg.get("voiceoverScript") or "").strip()
        if script and lid not in line_script:
            line_script[lid] = script
    for seg in segs:
        lid = int(seg["voiceoverLineId"])
        if not str(seg.get("voiceoverScript") or "").strip() and lid in line_script:
            seg["voiceoverScript"] = line_script[lid]

    edit_script["segments"] = segs
    _warn_dub_long_holds(segs)
    return annotate_dub_script_output_times(edit_script)


def _warn_dub_long_holds(segs: list[dict[str, Any]]) -> None:
    """Log when a voiceover line uses too few cuts — likely feels like long waits between angles."""
    from packages.core.logging import get_logger

    log = get_logger(__name__)
    by_line: dict[int, list[dict[str, Any]]] = {}
    for seg in segs:
        lid = int(seg.get("voiceoverLineId") or seg.get("order") or 0)
        by_line.setdefault(lid, []).append(seg)
    for lid, line_segs in by_line.items():
        if len(line_segs) >= 2:
            continue
        dur = _dub_segment_duration(line_segs[0])
        if dur > DUB_MAX_HOLD_SEC:
            log.warning(
                "dub_long_single_hold",
                voiceover_line_id=lid,
                duration_sec=round(dur, 1),
                hint="consider splitting into multiple angles on re-run",
            )


def annotate_dub_script_output_times(edit_script: dict[str, Any]) -> dict[str, Any]:
    """Add outputIn/outputOut per segment and voiceover-line spans for montage groups."""
    segs = edit_script.get("segments") or []
    cursor = 0.0
    for seg in segs:
        if not isinstance(seg, dict):
            continue
        dur = _dub_segment_duration(seg)
        seg["outputIn"] = round(cursor, 2)
        seg["outputOut"] = round(cursor + dur, 2)
        cursor += dur

    line_span: dict[int, dict[str, float]] = {}
    for seg in segs:
        if not isinstance(seg, dict):
            continue
        lid = seg.get("voiceoverLineId")
        if lid is None:
            continue
        try:
            line_id = int(lid)
        except (TypeError, ValueError):
            continue
        o_in = float(seg["outputIn"])
        o_out = float(seg["outputOut"])
        if line_id not in line_span:
            line_span[line_id] = {"outputIn": o_in, "outputOut": o_out}
        else:
            line_span[line_id]["outputOut"] = o_out

    for seg in segs:
        if not isinstance(seg, dict):
            continue
        lid = seg.get("voiceoverLineId")
        if lid is None:
            continue
        try:
            span = line_span[int(lid)]
        except (KeyError, TypeError, ValueError):
            continue
        seg["voiceoverLineOutputIn"] = span["outputIn"]
        seg["voiceoverLineOutputOut"] = span["outputOut"]

    if cursor > 0:
        edit_script["totalEstimatedSec"] = int(round(cursor))
    return edit_script
