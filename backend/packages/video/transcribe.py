"""faster-whisper decoding options + transcript cleanup.

Pure helpers (no model, no I/O) so the hallucination/cleanup logic is unit-testable.
The worker (`transcribe_video`) wires these around the actual WhisperModel call.
"""

from __future__ import annotations

import re
from typing import Any


def merge_graphemes_to_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge Whisper Thai grapheme-level tokens into proper words using pythainlp.

    Whisper splits Thai text into character/grapheme clusters (e.g. "อ","ั","น","ด","ั","บ").
    This function reconstructs the full text, uses pythainlp to tokenize into real words,
    then maps word boundaries back to the original timestamps.
    Falls back to original words if pythainlp is unavailable.
    """
    if not words:
        return words

    # Build full text from graphemes
    full_text = "".join(w.get("word", "") for w in words)
    if not full_text.strip():
        return words
    # Only Thai text is actually split into grapheme clusters by Whisper — running
    # non-Thai words (numbers, English fragments) through the Thai word tokenizer
    # can merge/collapse distinct words that were never grapheme fragments to
    # begin with, corrupting their timestamps.
    if not re.search(r"[฀-๿]", full_text):
        return words

    try:
        from pythainlp.tokenize import word_tokenize  # type: ignore[import-untyped]
    except ImportError:
        return words

    thai_words = word_tokenize(full_text, engine="newmm", keep_whitespace=False)
    if not thai_words:
        return words

    merged: list[dict[str, Any]] = []
    char_idx = 0
    word_idx = 0

    for thai_word in thai_words:
        if not thai_word.strip():
            char_idx += len(thai_word)
            continue
        word_len = len(thai_word)
        # Find which grapheme tokens cover this word
        covered_chars = 0
        start_ts: float | None = None
        end_ts: float | None = None
        g_idx = 0
        temp_char = char_idx
        # walk grapheme tokens to accumulate char_count == word_len
        while g_idx < len(words) and covered_chars < word_len:
            g = words[word_idx + g_idx] if (word_idx + g_idx) < len(words) else None
            if g is None:
                break
            token = g.get("word", "")
            if start_ts is None:
                start_ts = float(g.get("start", 0))
            end_ts = float(g.get("end", 0))
            covered_chars += len(token)
            g_idx += 1
        word_idx += g_idx
        char_idx += word_len
        if start_ts is not None and end_ts is not None:
            merged.append({"word": thai_word, "start": start_ts, "end": end_ts})

    return merged if merged else words

# Phrases Whisper commonly hallucinates over music / silence / breaths.
# Normalized (lowercased, punctuation/space-stripped) before comparison.
_HALLUCINATION_PHRASES = frozenset({
    "ขอบคุณค่ะ", "ขอบคุณครับ", "ขอบคุณที่รับชม", "ขอบคุณสำหรับการรับชม",
    "แล้วเจอกันใหม่", "สวัสดีค่ะ", "สวัสดีครับ", "ฝากกดไลค์กดแชร์",
    "thanksforwatching", "thankyouforwatching", "pleasesubscribe",
    "subscribe", "thankyou", "bye", "byebye", "you",
})

# Decode-confidence gates (faster-whisper exposes these per segment).
# Calibrated for Thai fine-tuned models (Thonburian) which output lower logprob
# than OpenAI base models even on clear speech.
NO_SPEECH_PROB_MAX = 0.60     # above this → likely non-speech
AVG_LOGPROB_MIN = -1.5        # Thai fine-tuned baseline is lower than English models,
# but real Thai speech sits around -0.4 to -0.8 — -2.0 is genuinely garbled output.
COMPRESSION_RATIO_MAX = 2.4   # above this → repetition loop (hallucination)
# A single word should not span longer than this (DTW timestamp glitch otherwise).
MAX_WORD_SPAN = 1.2
# Silence between two consecutive words inside ONE segment longer than this means
# the segment is not continuous speech (Whisper merged speech across a long pause /
# hallucinated a word over silence). Split the segment at that gap.
MAX_INTRA_SEGMENT_WORD_GAP = 2.0
# Keep VAD tail up to this beyond last word end (Thai tone decay lives here).
VAD_TAIL_PRESERVE_SEC = 0.45
# Segment end further than this past last word → glitch trim, not real speech.
GLITCH_OVERHANG_SEC = 1.0


# Seed Whisper's decoder with TikTok affiliate vocabulary so it spells
# domain-specific terms correctly instead of hallucinating phonetic guesses.
_THAI_AFFILIATE_PROMPT = (
    "แอฟฟิลิเอต คอมมิชชั่น ลิงก์ในไบโอ คลิกลิงก์ สินค้า รีวิว โปรโมชั่น "
    "ส่วนลด คูปอง ออเดอร์ แบรนด์ คอนเทนต์ ครีเอเตอร์ ไลฟ์สด ยอดขาย "
    "ตะกร้า เพิ่มในตะกร้า ชำระเงิน TikTok Shop"
)


# Re-run without VAD when the first pass misses large stretches of a long clip.
COVERAGE_RETRY_MIN = 0.25
LATE_START_RETRY_SEC = 90.0


def transcript_coverage_stats(
    segments: list[dict[str, Any]],
    source_duration_sec: float,
) -> dict[str, float]:
    """How much of the source timeline Whisper actually covered."""
    if source_duration_sec <= 0:
        return {"coverage": 0.0, "first_start": 0.0, "speech_sec": 0.0}
    if not segments:
        return {"coverage": 0.0, "first_start": float("inf"), "speech_sec": 0.0}
    speech = sum(float(s["end"]) - float(s["start"]) for s in segments)
    return {
        "coverage": speech / source_duration_sec,
        "first_start": float(segments[0]["start"]),
        "speech_sec": speech,
    }


def should_retry_transcription_without_vad(
    segments: list[dict[str, Any]],
    source_duration_sec: float,
) -> bool:
    """True when VAD likely skipped real speech (common on quiet intros / BGM)."""
    stats = transcript_coverage_stats(segments, source_duration_sec)
    return (
        stats["first_start"] > LATE_START_RETRY_SEC
        or stats["coverage"] < COVERAGE_RETRY_MIN
    )


def build_transcribe_options(
    *,
    language: str | None,
    beam_size: int = 5,
    vad_filter: bool = True,
) -> dict[str, Any]:
    """Return kwargs for WhisperModel.transcribe tuned to reduce hallucination."""
    opts: dict[str, Any] = {
        "language": (language or None),
        "beam_size": beam_size,
        "word_timestamps": True,
        "condition_on_previous_text": False,  # stops repetition spirals
        "initial_prompt": _THAI_AFFILIATE_PROMPT,
        "vad_filter": vad_filter,
        "no_speech_threshold": NO_SPEECH_PROB_MAX,
        "log_prob_threshold": AVG_LOGPROB_MIN,
        "compression_ratio_threshold": COMPRESSION_RATIO_MAX,
        # Temperature fallback: retry decoding when a pass looks degenerate.
        "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    }
    if vad_filter:
        opts["vad_parameters"] = {
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 350,   # more pre-roll → less mid-phoneme cut-in
            "threshold": 0.30,      # lower = catch more quiet speech under BGM
        }
    return opts


def _normalize(text: str) -> str:
    cleaned = re.sub(r"[^\w฀-๿]", "", text, flags=re.UNICODE)
    return cleaned.casefold()


def is_hallucinated_segment(
    text: str,
    *,
    no_speech_prob: float,
    avg_logprob: float,
    compression_ratio: float,
    log: "Any | None" = None,
) -> bool:
    """Heuristic: True when a segment is most likely a non-speech hallucination."""
    t = text.strip()
    if not t:
        return True
    if no_speech_prob >= NO_SPEECH_PROB_MAX:
        if log:
            log.debug("segment_dropped", reason="no_speech_prob", value=round(no_speech_prob, 3), text=t[:40])
        return True
    if avg_logprob < AVG_LOGPROB_MIN:
        if log:
            log.debug("segment_dropped", reason="avg_logprob", value=round(avg_logprob, 3), text=t[:40])
        return True
    if compression_ratio > COMPRESSION_RATIO_MAX:
        if log:
            log.debug("segment_dropped", reason="compression_ratio", value=round(compression_ratio, 3), text=t[:40])
        return True
    if _normalize(t) in _HALLUCINATION_PHRASES:
        if log:
            log.debug("segment_dropped", reason="hallucination_phrase", text=t[:40])
        return True
    return False


def tighten_segment_bounds(seg: dict[str, Any]) -> dict[str, Any]:
    """Clamp a segment's end to its last real word and cap per-word spans.

    Fixes the "one word stretched several seconds past the end" glitch where the
    segment / trailing word keeps running long after speech actually stopped.
    Returns a new dict; does not mutate the input.
    """
    words = list(seg.get("words") or [])
    start = float(seg["start"])
    end = float(seg["end"])

    if not words:
        return {**seg, "start": round(start, 3), "end": round(end, 3)}

    # Merge Thai grapheme clusters into proper words before timestamp processing
    words = merge_graphemes_to_words(words)

    fixed_words: list[dict[str, Any]] = []
    for i, w in enumerate(words):
        ws = float(w["start"])
        we = float(w["end"])
        # Cap an over-long single word; bound it by the next word's start.
        if we - ws > MAX_WORD_SPAN:
            we = ws + MAX_WORD_SPAN
        if i + 1 < len(words):
            nxt = float(words[i + 1]["start"])
            if nxt > ws:
                we = min(we, max(ws + 0.04, nxt - 0.03))
        we = max(we, ws)
        fixed_words.append({**w, "start": round(ws, 3), "end": round(we, 3)})

    last_word_end = float(fixed_words[-1]["end"])
    overhang = end - last_word_end
    if overhang > GLITCH_OVERHANG_SEC:
        # Absurd stretch (e.g. segment end 8s, last word 1.2s) — trim glitch only.
        new_end = last_word_end + 0.15
    elif overhang > 0:
        # Preserve VAD tail — Thai tone decay often sits after last word timestamp.
        new_end = min(end, last_word_end + VAD_TAIL_PRESERVE_SEC)
    else:
        new_end = max(end, last_word_end)
    new_end = max(new_end, start)
    return {
        **seg,
        "start": round(start, 3),
        "end": round(new_end, 3),
        "words": fixed_words,
    }


def split_segment_on_word_gaps(
    seg: dict[str, Any],
    *,
    max_gap_sec: float = MAX_INTRA_SEGMENT_WORD_GAP,
) -> list[dict[str, Any]]:
    """Split a Whisper segment when consecutive words are >max_gap_sec apart.

    Whisper (especially on long clips / via Modal) sometimes emits a single
    segment whose words straddle a long silence — e.g. word "มัน" at 80.3s and
    "เกิด" at 140.85s in the same segment. Downstream `build_speech_cuts` works
    at segment level and would keep all 60s of silence. Splitting here yields
    coherent sub-segments so silence-cut and repeat-dedupe behave correctly.

    Returns one or more segments. A segment with <2 words is returned unchanged.
    """
    words = list(seg.get("words") or [])
    if len(words) < 2:
        return [seg]

    groups: list[list[dict[str, Any]]] = [[words[0]]]
    for w in words[1:]:
        prev_end = float(groups[-1][-1]["end"])
        gap = float(w["start"]) - prev_end
        if gap > max_gap_sec:
            groups.append([w])
        else:
            groups[-1].append(w)

    if len(groups) < 2:
        return [seg]

    out: list[dict[str, Any]] = []
    for grp in groups:
        g_start = float(grp[0]["start"])
        g_end = float(grp[-1]["end"])
        text = "".join(str(w.get("word", "")) for w in grp).strip()
        out.append({
            **seg,
            "start": round(g_start, 3),
            "end": round(g_end, 3),
            "text": text,
            "words": grp,
        })
    return out
