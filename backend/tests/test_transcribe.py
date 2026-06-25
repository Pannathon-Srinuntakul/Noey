"""Unit tests for faster-whisper decode options + transcript cleanup."""

from packages.video.transcribe import (
    build_transcribe_options,
    is_hallucinated_segment,
    should_retry_transcription_without_vad,
    tighten_segment_bounds,
    transcript_coverage_stats,
)


# ── build_transcribe_options ────────────────────────────────────────────────────

def test_options_force_language():
    opt = build_transcribe_options(language="th")
    assert opt["language"] == "th"
    assert opt["word_timestamps"] is True
    assert opt["vad_filter"] is True
    assert opt["condition_on_previous_text"] is False


def test_options_empty_language_is_auto():
    opt = build_transcribe_options(language="")
    assert opt["language"] is None


def test_options_have_antihallucination_gates():
    opt = build_transcribe_options(language="th")
    assert opt["no_speech_threshold"] <= 0.7
    assert opt["compression_ratio_threshold"] <= 2.4
    assert isinstance(opt["temperature"], list) and len(opt["temperature"]) > 1


def test_options_no_vad_omits_vad_parameters():
    opt = build_transcribe_options(language="th", vad_filter=False)
    assert opt["vad_filter"] is False
    assert "vad_parameters" not in opt


def test_transcript_coverage_stats():
    segs = [{"start": 224.0, "end": 428.0, "text": "a"}]
    stats = transcript_coverage_stats(segs, 600.0)
    assert stats["first_start"] == 224.0
    assert 0.3 < stats["coverage"] < 0.35


def test_should_retry_when_late_start_or_low_coverage():
    segs = [{"start": 224.0, "end": 428.0, "text": "a"}]
    assert should_retry_transcription_without_vad(segs, 600.0) is True
    early = [{"start": 5.0, "end": 300.0, "text": "a"}]
    assert should_retry_transcription_without_vad(early, 600.0) is False


# ── is_hallucinated_segment ─────────────────────────────────────────────────────

def _clean_kwargs(**over):
    base = {"no_speech_prob": 0.05, "avg_logprob": -0.2, "compression_ratio": 1.5}
    base.update(over)
    return base


def test_good_segment_kept():
    assert is_hallucinated_segment("วันนี้มารีวิวสินค้า", **_clean_kwargs()) is False


def test_empty_text_dropped():
    assert is_hallucinated_segment("   ", **_clean_kwargs()) is True


def test_high_no_speech_dropped():
    assert is_hallucinated_segment("อะไรสักอย่าง", **_clean_kwargs(no_speech_prob=0.8)) is True


def test_low_logprob_dropped():
    # -2.0 is genuinely garbled; Thai normal speech is -0.4 to -0.8
    assert is_hallucinated_segment("เสียงไม่ชัด", **_clean_kwargs(avg_logprob=-2.0)) is True


def test_borderline_thai_logprob_kept():
    # Thai logprob -0.7 is normal for clear speech — must NOT be dropped
    assert is_hallucinated_segment("ครีมตัวนี้ดีมากเลย", **_clean_kwargs(avg_logprob=-0.7)) is False


def test_repetition_compression_dropped():
    assert is_hallucinated_segment("ๆๆๆๆๆๆ", **_clean_kwargs(compression_ratio=3.0)) is True


def test_common_hallucination_phrase_dropped():
    assert is_hallucinated_segment("ขอบคุณค่ะ", **_clean_kwargs()) is True
    assert is_hallucinated_segment("Thanks for watching!", **_clean_kwargs()) is True


def test_real_phrase_not_flagged_as_hallucination():
    assert is_hallucinated_segment("ครีมตัวนี้ดีมากเลยค่ะ", **_clean_kwargs()) is False


# ── tighten_segment_bounds ──────────────────────────────────────────────────────

def test_segment_end_clamped_to_last_word():
    seg = {
        "start": 0.0, "end": 8.0, "text": "สวัสดี",
        "words": [{"word": "สวัสดี", "start": 0.0, "end": 1.2}],
    }
    out = tighten_segment_bounds(seg)
    assert out["end"] == 1.35  # glitch trim: last word + 0.15s, not full 8s


def test_segment_end_preserves_vad_tail():
    seg = {
        "start": 0.0, "end": 1.55, "text": "สวัสดี",
        "words": [{"word": "สวัสดี", "start": 0.0, "end": 1.1}],
    }
    out = tighten_segment_bounds(seg)
    assert out["end"] == 1.55  # normal VAD tail kept


def test_segment_end_preserves_partial_vad_tail():
    seg = {
        "start": 0.0, "end": 1.40, "text": "ครับ",
        "words": [{"word": "ครับ", "start": 0.0, "end": 1.0}],
    }
    out = tighten_segment_bounds(seg)
    assert out["end"] == 1.40


def test_overlong_word_span_capped():
    seg = {
        "start": 0.0, "end": 10.0, "text": "คำ",
        "words": [{"word": "คำ", "start": 0.0, "end": 9.0}],
    }
    out = tighten_segment_bounds(seg)
    assert out["words"][0]["end"] - out["words"][0]["start"] <= 1.2
    assert out["end"] == 1.35  # capped word + 0.15s tail after glitch trim


def test_word_end_bounded_by_next_word_start():
    seg = {
        "start": 0.0, "end": 5.0, "text": "a b",
        "words": [
            {"word": "a", "start": 0.0, "end": 3.0},
            {"word": "b", "start": 1.0, "end": 2.0},
        ],
    }
    out = tighten_segment_bounds(seg)
    # first word end must not pass second word start (1.0)
    assert out["words"][0]["end"] <= 1.0


def test_no_words_passes_through():
    seg = {"start": 1.0, "end": 4.0, "text": "x", "words": []}
    out = tighten_segment_bounds(seg)
    assert out["start"] == 1.0 and out["end"] == 4.0


def test_does_not_mutate_input():
    seg = {"start": 0.0, "end": 9.0, "text": "hi",
           "words": [{"word": "hi", "start": 0.0, "end": 1.0}]}
    tighten_segment_bounds(seg)
    assert seg["end"] == 9.0  # original untouched
