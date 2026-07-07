"""Unit tests for the Gemini refine-pass merge/enforcement logic.

The critical invariant under test: Whisper owns timing. No matter what Gemini
returns, ``start``/``end``/``words`` on kept segments are exactly Whisper's.
"""

from packages.video.transcribe_refine import (
    CUT_ACTIONS,
    GEMINI_REFINE_SCHEMA,
    REFINE_ACTIONS,
    apply_refine_results,
    batch_segment_indices,
    build_refine_prompt,
    build_refine_request,
)


def _seg(start, end, text, words=None):
    return {
        "start": start,
        "end": end,
        "text": text,
        "words": words if words is not None else [{"word": text, "start": start, "end": end}],
    }


# ── build_refine_request ─────────────────────────────────────────────────────

def test_build_refine_request_strips_to_id_and_text():
    segs = [_seg(1.0, 2.0, "หนึ่ง"), _seg(5.0, 6.0, "สอง")]
    req = build_refine_request(segs)
    assert req == [{"id": 0, "text": "หนึ่ง"}, {"id": 1, "text": "สอง"}]


def test_build_refine_request_carries_no_timestamps():
    req = build_refine_request([_seg(3.0, 9.0, "x")])
    assert set(req[0].keys()) == {"id", "text"}
    assert "start" not in req[0] and "end" not in req[0] and "words" not in req[0]


# ── batch_segment_indices ────────────────────────────────────────────────────

def test_batch_all_in_one_when_under_span():
    segs = [_seg(0.0, 5.0, "a"), _seg(5.0, 10.0, "b")]
    assert batch_segment_indices(segs, 240.0) == [(0, 2)]


def test_batch_splits_when_span_exceeds_cap():
    # Spans: 0-100, 100-200, 260-300 → cap 240 keeps first two together (200<=240),
    # third (300 - 0 = 300 > 240) starts a new batch.
    segs = [_seg(0.0, 100.0, "a"), _seg(100.0, 200.0, "b"), _seg(260.0, 300.0, "c")]
    assert batch_segment_indices(segs, 240.0) == [(0, 2), (2, 3)]


def test_batch_oversized_single_segment_is_its_own_batch():
    segs = [_seg(0.0, 500.0, "long")]
    assert batch_segment_indices(segs, 240.0) == [(0, 1)]


def test_batch_empty():
    assert batch_segment_indices([], 240.0) == []


# ── apply_refine_results: timing is sacred ───────────────────────────────────

def test_keep_replaces_text_only_timing_untouched():
    segs = [_seg(1.234, 2.567, "สวัดดี", words=[{"word": "สวัดดี", "start": 1.234, "end": 2.567}])]
    results = [{"id": 0, "text": "สวัสดี", "action": "keep"}]
    out = apply_refine_results(segs, results)
    assert len(out) == 1
    assert out[0]["text"] == "สวัสดี"          # corrected
    assert out[0]["start"] == 1.234             # untouched
    assert out[0]["end"] == 2.567               # untouched
    assert out[0]["words"] == segs[0]["words"]  # untouched


def test_smuggled_timestamps_in_result_are_ignored():
    segs = [_seg(10.0, 12.0, "a")]
    # Gemini tries to override timing — must be ignored.
    results = [{"id": 0, "text": "a", "action": "keep", "start": 999.0, "end": 1000.0}]
    out = apply_refine_results(segs, results)
    assert out[0]["start"] == 10.0
    assert out[0]["end"] == 12.0


def test_cut_actions_drop_segment():
    segs = [_seg(0.0, 1.0, "keep me"), _seg(1.0, 2.0, "เอ่อ"), _seg(2.0, 3.0, "silence")]
    results = [
        {"id": 0, "text": "keep me", "action": "keep"},
        {"id": 1, "text": "เอ่อ", "action": "cut_stutter"},
        {"id": 2, "text": "", "action": "cut_dead_air"},
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


# ── schema + prompt sanity ───────────────────────────────────────────────────

def test_schema_has_no_timestamp_fields():
    item_props = GEMINI_REFINE_SCHEMA["properties"]["results"]["items"]["properties"]
    assert set(item_props.keys()) == {"id", "text", "action"}
    assert "start" not in item_props and "end" not in item_props


def test_schema_actions_match_constants():
    enum = GEMINI_REFINE_SCHEMA["properties"]["results"]["items"]["properties"]["action"]["enum"]
    assert set(enum) == set(REFINE_ACTIONS)
    assert "keep" in enum
    assert all(a in enum for a in CUT_ACTIONS)


def test_prompt_includes_segments_vocab_and_hard_rules():
    req = build_refine_request([_seg(0.0, 1.0, "สวัสดีค่ะ")])
    prompt = build_refine_prompt(req)
    assert "สวัสดีค่ะ" in prompt          # the actual segment text
    assert "TikTok Shop" in prompt         # affiliate vocab seed
    assert "NEVER output a timestamp" in prompt
    assert '"action"' in prompt
