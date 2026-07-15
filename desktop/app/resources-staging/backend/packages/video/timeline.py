"""Build edit timelines from Whisper transcript."""

from __future__ import annotations

import json
import re
from typing import Any

# Merge consecutive Whisper segments with gap ≤ this into one cut.
# Word-level gap threshold is no longer used for splitting — Thai Whisper splits
# text into individual characters whose timestamps can have large internal gaps
# (e.g. "ป"→"ั" gap > 0.8s inside "ปัน"), causing spurious mid-word cuts.
# 2.5s: used by resnap forward-look to re-absorb adjacent segments into a selected
# cut's tail — handles the gap inflation caused by tighten_segment_bounds (~0.5s).
SEGMENT_MERGE_GAP = 2.5   # resnap forward-look threshold — must stay > WORD_TAIL + JOIN_LEAD_IN
# Gap between speech segments long enough to be reviewed as its own candidate
# silence span (see build_silence_gap_candidates) — Gemini decides keep/cut per
# span based on whether something visually important happens during it.
EDITORIAL_BLOCK_GAP = 1.0
# Talking-head: total footage across ALL clips in a project, any clip count.
# Safe to keep generous — each clip gets its own independent Gemini review call
# (no shared/growing context across clips), so this is a practical ceiling, not
# a technical one.
TALKING_HEAD_MAX_TOTAL_SEC = 2 * 60 * 60


def talking_head_exceeds_total_limit(total_duration_sec: float) -> bool:
    """True when footage exceeds the talking_head cap (per-clip or summed project total)."""
    return float(total_duration_sec) > TALKING_HEAD_MAX_TOTAL_SEC


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


def build_silence_gap_candidates(
    speech_cuts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Candidate silent spans between kept speech cuts, for Gemini's silence-gap review.

    ``speech_cuts`` must be sorted by "in" (as ``build_speech_cuts`` returns them) — every gap
    between one cut's "out" and the next cut's "in" is, by construction, longer than the
    gap_threshold ``build_speech_cuts`` was given (shorter gaps get merged into one cut), so
    no extra threshold check is needed here. Gemini decides keep/cut per span; timing for a
    kept span always comes back from these exact bounds, never invented.
    """
    gaps: list[dict[str, Any]] = []
    for i in range(len(speech_cuts) - 1):
        gap_in = float(speech_cuts[i]["out"])
        gap_out = float(speech_cuts[i + 1]["in"])
        if gap_out > gap_in:
            gaps.append({"id": i, "in": round(gap_in, 3), "out": round(gap_out, 3)})
    return gaps


def _normalize_speech_text(text: str) -> str:
    """Normalize transcript text for duplicate-take comparison."""
    cleaned = re.sub(r"[^\w\s\u0E00-\u0E7F]", "", text, flags=re.UNICODE)
    cleaned = re.sub(r"\s+", "", cleaned)
    return cleaned.casefold()


def _relabel_opening_conclusion(cuts: list[dict[str, Any]]) -> None:
    if not cuts:
        return
    for cut in cuts:
        if cut.get("label") in ("opening", "conclusion", "hook", "highlight"):
            cut["label"] = "speech"
    cuts[0]["label"] = "opening"
    cuts[-1]["label"] = "conclusion"




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


def resolve_edit_target(mode: str, has_voiceover: bool) -> str:
    """Which on-disk file the manual editor reads/writes for a project.

    talking_head and dub_first-with-voiceover both render from timeline.json
    (render_video). dub_first without an uploaded voiceover renders from
    edit_script.json (render_dub_silent).
    """
    if mode == "dub_first" and not has_voiceover:
        return "edit_script"
    return "timeline"


def captions_for_edited_cuts(
    segments: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    cuts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Recompute output captions for a manually edited cut list.

    Edited cuts carry per-source-clip LOCAL in/out (same as timeline.json),
    but build_captions_for_cuts expects times in the transcript's combined
    (pre-localization) timeline — so cuts are globalized via clip boundaries
    before mapping.
    """
    boundaries = build_clip_boundaries([float(s.get("durationSec", 0.0)) for s in sources])
    offset_by_id = {b["id"]: b["start"] for b in boundaries}
    global_cuts = [
        {
            **c,
            "in": offset_by_id.get(c["source"], 0.0) + float(c["in"]),
            "out": offset_by_id.get(c["source"], 0.0) + float(c["out"]),
        }
        for c in cuts
    ]
    return build_captions_for_cuts(segments, global_cuts)


# Dub-first silent preview floor (talking_head keeps MIN_KEEP_CUT_SEC).
DUB_MIN_CUT_SEC = 0.35
# Soft cap: one angle should not linger longer than this when more cuts are possible.
DUB_MAX_HOLD_SEC = 3.5
# When model picks sourceIn far from a sampled frame, snap trim to that frame.
DUB_ANCHOR_TOLERANCE_SEC = 0.35
# Treat sample anchors within this window as the same scene (no reuse).
DUB_FRAME_DEDUPE_TOLERANCE_SEC = 0.5
# Segments starting within this many seconds of each other are considered duplicates.
DUB_SOURCE_DEDUPE_SEC = 1.0


def dub_segments_from_edit_cuts(cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map manual edit-timeline cuts back to dub edit_script segment rows."""
    segs: list[dict[str, Any]] = []
    for i, c in enumerate(cuts):
        raw_lid = c.get("voiceoverLineId")
        if raw_lid is not None:
            try:
                line_id = int(raw_lid)
            except (TypeError, ValueError):
                line_id = i + 1
        else:
            label = str(c.get("label") or "").strip()
            try:
                line_id = int(label) if label else (i + 1)
            except ValueError:
                line_id = i + 1
        src_in = float(c["in"])
        src_out = float(c["out"])
        segs.append({
            "order": i + 1,
            "sourceClip": str(c.get("source") or "clip0"),
            "sourceIn": src_in,
            "sourceOut": src_out,
            "durationSec": round(max(0.0, src_out - src_in), 2),
            "voiceoverLineId": line_id,
            "voiceoverScript": str(c.get("voiceoverScript") or ""),
            "cutStyle": "jump_cut",
        })
    return segs


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
    """Drop duplicate frame anchors; preserve AI playback order (do not re-sort by source time)."""
    from packages.core.logging import get_logger

    log = get_logger(__name__)

    segs = [dict(s) for s in (edit_script.get("segments") or []) if isinstance(s, dict)]
    if not segs or not sample_frames:
        return edit_script

    for seg in segs:
        _, _, frame = _resolve_frame_anchor(seg, sample_frames)
        if frame is not None:
            _apply_frame_to_segment(seg, frame)

    segs.sort(key=lambda s: int(s.get("order") or 0))

    used_keys: set[tuple[str, float]] = set()
    kept: list[dict[str, Any]] = []
    dropped = 0

    for seg in segs:
        clip_id = str(seg.get("sourceClip") or "clip0")
        try:
            src_in = float(seg.get("sourceIn", 0))
        except (TypeError, ValueError):
            src_in = 0.0
        key = (clip_id, round(src_in / DUB_SOURCE_DEDUPE_SEC) * DUB_SOURCE_DEDUPE_SEC)
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
            "dub_unique_enforced",
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
        if scene_start <= src_in <= scene_end:
            continue  # sourceIn already inside the scene window — don't snap
        new_in = max(scene_start, min(anchor, scene_end - dur))
        new_out = min(scene_end, new_in + dur)
        if new_out - new_in < DUB_MIN_CUT_SEC:
            continue

        seg["sourceIn"] = round(new_in, 2)
        seg["sourceOut"] = round(new_out, 2)
        seg["durationSec"] = round(new_out - new_in, 2)
        seg["matchedFrameTime"] = round(anchor, 2)

    return edit_script


def clamp_dub_segments_to_clip_durations(
    edit_script: dict[str, Any],
    clip_durations: dict[str, float],
) -> dict[str, Any]:
    """Drop/clamp segments whose sourceIn/sourceOut fall outside their clip's real duration.

    Safety net for the Gemini video path: unlike Claude+frames (every timestamp
    is bounded by a real sampled frame), Gemini can output a timestamp beyond
    the actual clip length — observed in production while padding toward the
    duration floor. Prompt-only guidance is not sufficient (Gemini has also
    been observed ignoring output-shape instructions), so this validates in
    code. sourceOut is clamped down to the clip's duration (small overshoot —
    a rounding slip); a segment starting at/after the clip's end is dropped
    entirely (no real footage left to salvage).

    Logs every drop at WARNING with the reason — this is the main diagnostic
    for "the script text mentions a shot but the render doesn't have it": if a
    montage line's sub-cut gets dropped here while a sibling cut (which shares
    the line's voiceoverScript, filled in by normalize_dub_edit_script) survives,
    the line's TEXT still describes the dropped shot even though only the
    surviving cut renders.
    """
    from packages.core.logging import get_logger

    log = get_logger(__name__)

    segs = [s for s in (edit_script.get("segments") or []) if isinstance(s, dict)]
    kept: list[dict[str, Any]] = []
    dropped = 0
    for seg in segs:
        order = seg.get("order")
        clip_id = str(seg.get("sourceClip") or "")
        dur = clip_durations.get(clip_id)
        if dur is None:
            log.warning(
                "dub_segment_dropped", reason="unknown_clip", order=order,
                source_clip=clip_id, known_clips=list(clip_durations),
            )
            dropped += 1
            continue
        try:
            src_in = float(seg["sourceIn"])
            src_out = float(seg["sourceOut"])
        except (KeyError, TypeError, ValueError):
            log.warning(
                "dub_segment_dropped", reason="unparseable_timestamps", order=order,
                source_clip=clip_id, sourceIn=seg.get("sourceIn"), sourceOut=seg.get("sourceOut"),
            )
            dropped += 1
            continue
        if src_in < 0 or src_out <= src_in or src_in >= dur:
            log.warning(
                "dub_segment_dropped", reason="out_of_range", order=order,
                source_clip=clip_id, source_in=src_in, source_out=src_out, clip_duration_sec=dur,
            )
            dropped += 1
            continue
        clamped = src_out > dur
        src_out = min(src_out, dur)
        if src_out - src_in < DUB_MIN_CUT_SEC:
            log.warning(
                "dub_segment_dropped", reason="too_short_after_clamp", order=order,
                source_clip=clip_id, source_in=src_in, source_out=src_out,
            )
            dropped += 1
            continue
        if clamped:
            log.warning(
                "dub_segment_clamped", order=order, source_clip=clip_id,
                source_out_original=round(float(seg["sourceOut"]), 2), clip_duration_sec=dur,
            )
        seg["sourceIn"] = round(src_in, 2)
        seg["sourceOut"] = round(src_out, 2)
        mft = seg.get("matchedFrameTime")
        if mft is not None:
            try:
                seg["matchedFrameTime"] = round(min(max(float(mft), 0.0), dur), 2)
            except (TypeError, ValueError):
                pass
        kept.append(seg)
    if dropped:
        log.warning(
            "dub_segments_clamp_summary", total=len(segs), kept=len(kept), dropped=dropped,
        )
    edit_script["segments"] = kept
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


def merge_dub_reedit_segments(
    edit_script: dict[str, Any],
    selected_line_ids: list[int],
    new_segments: list[dict[str, Any]],
) -> dict[str, Any]:
    """Splice an AI re-edit result back into the full edit script.

    Scoped (selected_line_ids non-empty): drop every segment whose
    voiceoverLineId is in the selection, insert new_segments at that position
    (empty new_segments = the selected line(s) were deleted).
    Whole-script (selected_line_ids empty): new_segments IS the full
    replacement array — the model was instructed to echo back every
    untouched line unchanged.

    Either way, re-sequences `order` to match final position (the model's own
    order values aren't trustworthy across a splice) and re-runs
    normalize_dub_edit_script so durationSec/montage-script-fill/
    totalEstimatedSec stay consistent — reused rather than duplicated here.
    """
    segs = [s for s in (edit_script.get("segments") or []) if isinstance(s, dict)]

    if selected_line_ids:
        selected = set(selected_line_ids)
        merged: list[dict[str, Any]] = []
        spliced = False
        for seg in segs:
            lid = seg.get("voiceoverLineId")
            try:
                lid = int(lid) if lid is not None else None
            except (TypeError, ValueError):
                lid = None
            if lid in selected:
                if not spliced:
                    merged.extend(dict(s) for s in new_segments)
                    spliced = True
                continue
            merged.append(seg)
        if not spliced:
            # Selected line(s) not found in the current script (stale selection) — append at the end.
            merged.extend(dict(s) for s in new_segments)
    else:
        merged = [dict(s) for s in new_segments]

    for i, seg in enumerate(merged, start=1):
        seg["order"] = i

    return normalize_dub_edit_script(
        {"mode": edit_script.get("mode", "dub_first"), "segments": merged},
        sample_frames=None,
    )
