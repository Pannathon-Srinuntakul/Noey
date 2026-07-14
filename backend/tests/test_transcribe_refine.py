"""Unit tests for the Gemini video-review merge/request logic.

The critical invariant under test: Whisper owns timing. No matter what Gemini
returns, ``start``/``end``/``words`` on kept segments (and ``in``/``out`` on
kept silence gaps) are exactly Whisper's / build_silence_gap_candidates'.
Segment/gap *requests* do carry real start/end (Gemini needs it to know where
to look in the video) — only the response schema is timestamp-free, which is
what actually makes a timestamp hallucination structurally impossible.
"""

from packages.video.transcribe_refine import (
    CUT_ACTIONS,
    GEMINI_REFINE_SCHEMA,
    REFINE_ACTIONS,
    apply_refine_results,
    apply_silence_gap_results,
    build_refine_request,
    build_silence_gap_request,
    build_talking_review_user_text,
    redistribute_text_over_slots,
)


def _seg(start, end, text, words=None):
    return {
        "start": start,
        "end": end,
        "text": text,
        "words": words if words is not None else [{"word": text, "start": start, "end": end}],
    }


# ── build_refine_request ─────────────────────────────────────────────────────

def test_build_refine_request_includes_id_start_end_text():
    segs = [_seg(1.0, 2.0, "หนึ่ง"), _seg(5.0, 6.0, "สอง")]
    req = build_refine_request(segs)
    assert req == [
        {"id": 0, "start": 1.0, "end": 2.0, "text": "หนึ่ง"},
        {"id": 1, "start": 5.0, "end": 6.0, "text": "สอง"},
    ]


# ── build_silence_gap_request ────────────────────────────────────────────────

def test_build_silence_gap_request_maps_in_out_to_start_end():
    gaps = [{"id": 0, "in": 5.0, "out": 8.5}, {"id": 1, "in": 20.0, "out": 22.0}]
    req = build_silence_gap_request(gaps)
    assert req == [
        {"id": 0, "start": 5.0, "end": 8.5},
        {"id": 1, "start": 20.0, "end": 22.0},
    ]


# ── redistribute_text_over_slots ─────────────────────────────────────────────

def test_redistribute_single_slot_spans_the_slots_own_range():
    # "แก้แล้ว" tokenizes into 2 real words — even a single original slot can
    # expand into multiple output words, all confined to that slot's span.
    slots = [{"word": "old", "start": 1.0, "end": 2.0}]
    out = redistribute_text_over_slots("แก้แล้ว", slots)
    assert "".join(w["word"] for w in out) == "แก้แล้ว"
    assert out[0]["start"] == 1.0
    assert out[-1]["end"] == 2.0


def test_redistribute_splits_on_real_thai_word_boundaries():
    # 3 original (e.g. corrupted/grapheme-fragment) slots spanning [0.0, 3.0];
    # corrected text is real Thai words — output must be exactly those real
    # words, never a mid-syllable character slice (the bug the old
    # character-count design had: "หัว" could come out as "หั" + "ว").
    slots = [
        {"word": "x", "start": 0.0, "end": 1.0},
        {"word": "y", "start": 1.0, "end": 2.0},
        {"word": "z", "start": 2.0, "end": 3.0},
    ]
    out = redistribute_text_over_slots("สวัสดีครับ", slots)
    words = [w["word"] for w in out]
    assert "".join(words) == "สวัสดีครับ"  # no characters dropped
    assert all(w for w in words)  # no empty fragments

    from pythainlp.tokenize import word_tokenize

    expected = [w for w in word_tokenize("สวัสดีครับ", engine="newmm", keep_whitespace=False) if w.strip()]
    assert words == expected  # every output word is a real tokenizer word, not a raw slice


def test_redistribute_spans_stay_within_original_slot_range():
    slots = [
        {"word": "a", "start": 5.0, "end": 5.3},
        {"word": "b", "start": 5.3, "end": 5.6},
    ]
    out = redistribute_text_over_slots("ไปกินข้าว", slots)
    assert out[0]["start"] == 5.0
    assert out[-1]["end"] == 5.6
    for w in out:
        assert 5.0 <= w["start"] <= 5.6
        assert 5.0 <= w["end"] <= 5.6


def test_redistribute_empty_text_returns_empty():
    assert redistribute_text_over_slots("", [{"word": "a", "start": 0.0, "end": 1.0}]) == []


def test_redistribute_no_slots_returns_empty():
    assert redistribute_text_over_slots("hello", []) == []


# ── apply_refine_results: timing is sacred ───────────────────────────────────

def test_keep_replaces_text_only_timing_untouched():
    segs = [_seg(1.234, 2.567, "สวัดดี", words=[{"word": "สวัดดี", "start": 1.234, "end": 2.567}])]
    results = [{"id": 0, "text": "สวัสดี", "action": "keep"}]
    out = apply_refine_results(segs, results)
    assert len(out) == 1
    assert out[0]["text"] == "สวัสดี"          # corrected
    assert out[0]["start"] == 1.234             # untouched
    assert out[0]["end"] == 2.567               # untouched
    # word-level TIMING is untouched; the word's own text now carries the
    # correction too (redistribute_text_over_slots), so burned-in per-word
    # captions show the same fix as the segment-level text does.
    assert out[0]["words"] == [{"word": "สวัสดี", "start": 1.234, "end": 2.567}]


def test_smuggled_timestamps_in_result_are_ignored():
    segs = [_seg(10.0, 12.0, "a")]
    # Gemini tries to override timing — must be ignored.
    results = [{"id": 0, "text": "a", "action": "keep", "start": 999.0, "end": 1000.0}]
    out = apply_refine_results(segs, results)
    assert out[0]["start"] == 10.0
    assert out[0]["end"] == 12.0


def test_cut_actions_drop_segment():
    segs = [
        _seg(0.0, 1.0, "keep me"),
        _seg(1.0, 2.0, "เอ่อ"),
        _seg(2.0, 3.0, "silence"),
        _seg(3.0, 4.0, "same point again"),
    ]
    results = [
        {"id": 0, "text": "keep me", "action": "keep"},
        {"id": 1, "text": "เอ่อ", "action": "cut_stutter"},
        {"id": 2, "text": "", "action": "cut_dead_air"},
        {"id": 3, "text": "same point again", "action": "cut_semantic_repeat"},
    ]
    out = apply_refine_results(segs, results)
    assert [s["text"] for s in out] == ["keep me"]


def test_missing_id_keeps_segment_unchanged():
    segs = [_seg(0.0, 1.0, "one"), _seg(1.0, 2.0, "two")]
    results = [{"id": 0, "text": "ONE", "action": "keep"}]  # id 1 absent
    out = apply_refine_results(segs, results)
    assert out[0]["text"] == "ONE"
    assert out[1] == segs[1]  # untouched fallback


def test_empty_results_keeps_all_segments():
    segs = [_seg(0.0, 1.0, "a"), _seg(1.0, 2.0, "b")]
    out = apply_refine_results(segs, [])
    assert out == segs


def test_malformed_results_are_skipped_not_crashing():
    segs = [_seg(0.0, 1.0, "a")]
    results = ["not a dict", {"no_id": 1}, {"id": "NaN", "action": "keep"}, {"id": 0, "text": "A", "action": "keep"}]
    out = apply_refine_results(segs, results)
    assert out[0]["text"] == "A"


def test_keep_with_empty_text_falls_back_to_original():
    segs = [_seg(0.0, 1.0, "original")]
    results = [{"id": 0, "text": "   ", "action": "keep"}]
    out = apply_refine_results(segs, results)
    assert out[0]["text"] == "original"


def test_unknown_action_treated_as_keep():
    segs = [_seg(0.0, 1.0, "x")]
    results = [{"id": 0, "text": "y", "action": "banana"}]
    out = apply_refine_results(segs, results)
    assert out[0]["text"] == "y"


# ── apply_silence_gap_results: timing is sacred here too ────────────────────

def test_silence_gap_keep_true_survives():
    gaps = [{"id": 0, "in": 5.0, "out": 8.5}, {"id": 1, "in": 20.0, "out": 22.0}]
    results = [{"id": 0, "keep": True}, {"id": 1, "keep": False}]
    out = apply_silence_gap_results(gaps, results)
    assert out == [{"id": 0, "in": 5.0, "out": 8.5}]


def test_silence_gap_smuggled_timestamps_are_ignored():
    gaps = [{"id": 0, "in": 5.0, "out": 8.5}]
    results = [{"id": 0, "keep": True, "in": 999.0, "out": 1000.0}]
    out = apply_silence_gap_results(gaps, results)
    assert out[0]["in"] == 5.0
    assert out[0]["out"] == 8.5


def test_silence_gap_missing_or_malformed_result_drops_gap():
    gaps = [{"id": 0, "in": 5.0, "out": 8.5}, {"id": 1, "in": 20.0, "out": 22.0}]
    results = [{"id": 0, "keep": True}]  # id 1 absent — conservatively dropped
    out = apply_silence_gap_results(gaps, results)
    assert len(out) == 1
    assert out[0]["id"] == 0


def test_silence_gap_trims_to_meaningful_sub_range():
    """A long gap where only part matters gets narrowed, not kept in full."""
    gaps = [{"id": 0, "in": 20.0, "out": 80.0}]  # 60s gap
    results = [{"id": 0, "keep": True, "start_pct": 0.45, "end_pct": 0.53}]
    out = apply_silence_gap_results(gaps, results)
    assert len(out) == 1
    assert out[0]["in"] == 47.0   # 20 + 0.45*60
    assert out[0]["out"] == 51.8  # 20 + 0.53*60


def test_silence_gap_pct_clamped_to_valid_range():
    """Fractions outside [0, 1] are clamped, never allowed to escape the real gap."""
    gaps = [{"id": 0, "in": 10.0, "out": 20.0}]
    results = [{"id": 0, "keep": True, "start_pct": -5.0, "end_pct": 50.0}]
    out = apply_silence_gap_results(gaps, results)
    assert out[0]["in"] == 10.0
    assert out[0]["out"] == 20.0


def test_silence_gap_malformed_pct_range_falls_back_to_full_gap():
    """end_pct <= start_pct is nonsensical — fall back to keeping the whole gap."""
    gaps = [{"id": 0, "in": 10.0, "out": 20.0}]
    results = [{"id": 0, "keep": True, "start_pct": 0.8, "end_pct": 0.2}]
    out = apply_silence_gap_results(gaps, results)
    assert out[0]["in"] == 10.0
    assert out[0]["out"] == 20.0


def test_silence_gap_missing_pct_defaults_to_full_gap():
    gaps = [{"id": 0, "in": 5.0, "out": 8.5}]
    results = [{"id": 0, "keep": True}]  # no start_pct/end_pct given
    out = apply_silence_gap_results(gaps, results)
    assert out[0]["in"] == 5.0
    assert out[0]["out"] == 8.5


# ── schema + prompt sanity ───────────────────────────────────────────────────

def test_schema_has_no_timestamp_fields():
    result_props = GEMINI_REFINE_SCHEMA["properties"]["results"]["items"]["properties"]
    assert set(result_props.keys()) == {"id", "text", "action"}
    assert "start" not in result_props and "end" not in result_props

    gap_props = GEMINI_REFINE_SCHEMA["properties"]["silence_gaps"]["items"]["properties"]
    assert set(gap_props.keys()) == {"id", "keep", "start_pct", "end_pct"}
    assert "start" not in gap_props and "end" not in gap_props


def test_schema_actions_match_constants():
    enum = GEMINI_REFINE_SCHEMA["properties"]["results"]["items"]["properties"]["action"]["enum"]
    assert set(enum) == set(REFINE_ACTIONS)
    assert "keep" in enum
    assert all(a in enum for a in CUT_ACTIONS)
    assert "cut_semantic_repeat" in CUT_ACTIONS


def test_user_text_includes_segments_gaps_vocab_and_brief():
    text = build_talking_review_user_text(
        segments=[_seg(0.0, 1.0, "สวัสดีค่ะ")],
        gaps=[{"id": 0, "in": 5.0, "out": 8.0}],
        brief="รีวิวรองเท้ายี่ห้อ X",
    )
    assert "สวัสดีค่ะ" in text          # the actual segment text
    assert "TikTok Shop" in text        # affiliate vocab seed
    assert "NEVER output a timestamp" in text
    assert "รีวิวรองเท้ายี่ห้อ X" in text  # creator-provided context
    assert '"silence_gaps"' in text or "silence_gaps" in text


def test_user_text_omits_brief_block_when_empty():
    text = build_talking_review_user_text(
        segments=[_seg(0.0, 1.0, "a")], gaps=[], brief="",
    )
    assert "creator_context" not in text
