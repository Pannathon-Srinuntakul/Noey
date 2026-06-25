"""Multi-clip timeline mapping tests."""

from packages.video.timeline import (
    _repair_segment_words,
    _snap_to_words,
    apply_semantic_dedupe_plan,
    annotate_dub_script_output_times,
    normalize_dub_edit_script,
    build_clip_boundaries,
    build_speech_blocks,
    build_speech_cuts,
    cascade_filter_keep_ids,
    dedupe_repeated_cuts,
    dedupe_spaced_word_repeats,
    enforce_cuts_budget,
    filter_renderable_cuts,
    filter_short_cuts,
    is_likely_continuation,
    localize_cuts,
    remove_overlapping_cuts,
    select_speech_cuts_by_ids,
    resnap_selected_cuts,
    split_cuts_on_internal_silence,
    split_global_cut,
    trim_range_to_segment_budget,
    cuts_duration,
    MAX_WORD_DUR,
    WORD_TAIL,
)


def test_build_clip_boundaries_offsets() -> None:
    boundaries = build_clip_boundaries([10.0, 20.0, 5.0])
    assert boundaries[0]["id"] == "clip0"
    assert boundaries[0]["start"] == 0.0
    assert boundaries[0]["end"] == 10.0
    assert boundaries[1]["start"] == 10.0
    assert boundaries[1]["end"] == 30.0
    assert boundaries[2]["start"] == 30.0
    assert boundaries[2]["end"] == 35.0


def test_localize_cuts_splits_across_clips() -> None:
    boundaries = build_clip_boundaries([10.0, 10.0])
    global_cuts = [{"type": "cut", "source": "clip0", "in": 8.0, "out": 12.0, "label": "speech"}]
    localized = localize_cuts(global_cuts, boundaries)
    assert len(localized) == 2
    assert localized[0]["source"] == "clip0"
    assert localized[0]["in"] == 8.0
    assert localized[0]["out"] == 10.0
    assert localized[1]["source"] == "clip1"
    assert localized[1]["in"] == 0.0
    assert localized[1]["out"] == 2.0


def test_split_global_cut_wholly_inside_second_clip() -> None:
    boundaries = build_clip_boundaries([10.0, 10.0])
    parts = split_global_cut(15.0, 18.0, boundaries, label="hook")
    assert len(parts) == 1
    assert parts[0]["source"] == "clip1"
    assert parts[0]["in"] == 5.0
    assert parts[0]["out"] == 8.0
    assert parts[0]["label"] == "hook"


def test_filter_renderable_cuts_drops_subframe_segments() -> None:
    cuts = [
        {"type": "cut", "source": "clip0", "in": 1.0, "out": 2.0, "label": "speech"},
        {"type": "cut", "source": "clip4", "in": 600.326, "out": 600.374, "label": "speech"},
    ]
    kept = filter_renderable_cuts(cuts)
    assert len(kept) == 1
    assert kept[0]["in"] == 1.0


def test_filter_short_cuts_drops_under_one_second() -> None:
    cuts = [
        {"type": "cut", "source": "clip0", "in": 1.0, "out": 1.9, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 2.0, "out": 3.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 4.0, "out": 5.0, "label": "speech"},
    ]
    kept = filter_short_cuts(cuts)
    assert len(kept) == 2
    assert kept[0]["in"] == 2.0
    assert kept[1]["in"] == 4.0


def test_dedupe_repeated_cuts_keeps_latest_take() -> None:
    segments = [
        {
            "start": 0.0,
            "end": 4.0,
            "text": "วันนี้มารีวิวครีมตัวนี้",
            "words": [
                {"word": "วันนี้", "start": 0.0, "end": 0.5},
                {"word": "มารีวิว", "start": 0.5, "end": 1.2},
                {"word": "ครีม", "start": 1.2, "end": 1.8},
                {"word": "ตัวนี้", "start": 1.8, "end": 2.4},
            ],
        },
        {
            "start": 10.0,
            "end": 12.0,
            "text": "วันนี้มารีวิวครีม",
            "words": [
                {"word": "วันนี้", "start": 10.0, "end": 10.4},
                {"word": "มารีวิว", "start": 10.4, "end": 11.0},
                {"word": "ครีม", "start": 11.0, "end": 11.6},
            ],
        },
        {
            "start": 20.0,
            "end": 25.0,
            "text": "ราคาไม่แพงมาก",
            "words": [
                {"word": "ราคา", "start": 20.0, "end": 20.6},
                {"word": "ไม่แพง", "start": 20.6, "end": 21.2},
                {"word": "มาก", "start": 21.2, "end": 21.8},
            ],
        },
    ]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 3.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 10.0, "out": 12.5, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 20.0, "end": 22.5, "out": 22.5, "label": "conclusion"},
    ]
    cuts[2] = {"type": "cut", "source": "clip0", "in": 20.0, "out": 22.5, "label": "conclusion"}

    kept = dedupe_repeated_cuts(cuts, segments)
    assert len(kept) == 2
    assert kept[0]["in"] == 10.0
    assert kept[1]["in"] == 20.0


def test_dedupe_spaced_word_repeats_drops_thung_retakes() -> None:
    """Spaced single-word retakes (>1s gap) keep latest; multi-word lead-in stays."""
    segments = [{
        "start": 42.0,
        "end": 53.0,
        "text": "เสร็จ ถิ้ง ถิ้ง ถิ้ง",
        "words": [
            {"word": "เสร็จ", "start": 42.23, "end": 43.43},
            {"word": "ถิ้ง", "start": 43.71, "end": 44.91},
            {"word": "ถิ้ง", "start": 47.74, "end": 48.94},
            {"word": "ถิ้ง", "start": 51.75, "end": 52.95},
        ],
    }]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 41.95, "out": 45.86, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 47.46, "out": 49.89, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 51.47, "out": 53.90, "label": "speech"},
    ]
    kept = dedupe_spaced_word_repeats(cuts, segments)
    assert len(kept) == 2
    assert kept[0]["in"] == 41.95
    assert kept[1]["in"] == 51.47


def test_dedupe_spaced_word_repeats_keeps_consecutive_emphasis() -> None:
    """Same word repeated quickly (gap <= 1s) is intentional — keep all cuts."""
    segments = [{
        "start": 0.0,
        "end": 3.0,
        "text": "ดี ดี ดี",
        "words": [
            {"word": "ดี", "start": 0.0, "end": 0.5},
            {"word": "ดี", "start": 0.6, "end": 1.1},
            {"word": "ดี", "start": 1.2, "end": 1.7},
        ],
    }]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 0.55, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 0.58, "out": 1.15, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 1.18, "out": 1.75, "label": "speech"},
    ]
    kept = dedupe_spaced_word_repeats(cuts, segments)
    assert len(kept) == 3


def test_dedupe_repeated_cuts_drops_spaced_phrase_retake() -> None:
    """Same multi-word phrase >0.5s apart → drop retake."""
    phrase = "วันนี้มารีวิวครีมตัวนี้"
    segments = [
        {
            "start": 0.0, "end": 8.0, "text": phrase,
            "words": [
                {"word": "วันนี้", "start": 0.0, "end": 0.5},
                {"word": "มารีวิว", "start": 0.5, "end": 1.2},
                {"word": "ครีม", "start": 1.2, "end": 1.8},
                {"word": "ตัวนี้", "start": 1.8, "end": 2.4},
                {"word": "วันนี้", "start": 5.0, "end": 5.5},
                {"word": "มารีวิว", "start": 5.5, "end": 6.2},
                {"word": "ครีม", "start": 6.2, "end": 6.8},
                {"word": "ตัวนี้", "start": 6.8, "end": 7.4},
            ],
        },
    ]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 3.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 5.0, "out": 8.0, "label": "speech"},
    ]
    kept = dedupe_repeated_cuts(cuts, segments)
    assert len(kept) == 1
    assert kept[0]["in"] == 5.0


def test_dedupe_repeated_cuts_keeps_consecutive_phrase() -> None:
    """Same phrase repeated within 0.5s gap → keep both."""
    phrase = "ดีมากเลยนะ"
    segments = [{
        "start": 0.0, "end": 2.0, "text": phrase,
        "words": [
            {"word": "ดี", "start": 0.0, "end": 0.3},
            {"word": "มาก", "start": 0.35, "end": 0.6},
            {"word": "เลย", "start": 0.65, "end": 0.9},
            {"word": "นะ", "start": 0.95, "end": 1.2},
        ],
    }]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 1.25, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 1.35, "out": 2.0, "label": "speech"},
    ]
    kept = dedupe_repeated_cuts(cuts, segments)
    assert len(kept) == 2


def test_dedupe_repeated_cuts_short_identical_text() -> None:
    """Single-word identical cuts are handled by dedupe_spaced_word_repeats, not phrase dedupe."""
    segments = [
        {"start": 10.0, "end": 11.0, "text": "โอเค", "words": [{"word": "โอเค", "start": 10.0, "end": 11.0}]},
        {"start": 15.0, "end": 16.0, "text": "โอเค", "words": [{"word": "โอเค", "start": 15.0, "end": 16.0}]},
    ]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 10.0, "out": 11.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 15.0, "out": 16.0, "label": "speech"},
    ]
    assert len(dedupe_repeated_cuts(cuts, segments)) == 2
    kept = dedupe_spaced_word_repeats(cuts, segments)
    assert len(kept) == 1
    assert kept[0]["in"] == 15.0


def test_dedupe_repeated_cuts_keeps_distinct_phrases() -> None:
    segments = [
        {"start": 0.0, "end": 2.0, "text": "เปิดคลิปวันนี้", "words": []},
        {"start": 5.0, "end": 7.0, "text": "โชว์เนื้อครีม", "words": []},
    ]
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 2.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 5.0, "out": 7.0, "label": "conclusion"},
    ]
    kept = dedupe_repeated_cuts(cuts, segments)
    assert len(kept) == 2


def test_remove_overlapping_cuts_trims_later_cut() -> None:
    """Overlapping resnap must not drop the entire later cut (475c37ee regression)."""
    cuts = [
        {"type": "cut", "source": "clip0", "in": 81.24, "out": 150.47, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 131.59, "out": 287.15, "label": "speech"},
    ]
    kept = remove_overlapping_cuts(cuts)
    assert len(kept) == 2
    assert kept[0]["out"] == 150.47
    assert kept[1]["in"] >= 150.47
    assert kept[1]["out"] == 287.15


def test_snap_to_words_extends_past_last_word_end() -> None:
    words = [(1.0, 1.4), (1.5, 2.0), (2.1, 2.55)]
    cut_in, cut_out = _snap_to_words(1.0, 2.55, words, is_opening=False, is_conclusion=False)
    assert cut_in <= 1.0
    assert cut_out >= 2.55 + WORD_TAIL - 0.01


def test_repair_extends_last_word_to_segment_end() -> None:
    seg = {
        "start": 10.0,
        "end": 12.5,
        "text": "สวัสดีครับ",
        "words": [
            {"word": "สวัสดี", "start": 10.0, "end": 11.8},
            {"word": "ครับ", "start": 11.8, "end": 11.85},
        ],
    }
    repaired = _repair_segment_words(seg)
    assert repaired[-1][1] >= 12.5 - 0.01


def test_repair_clamps_absurd_word_span() -> None:
    seg = {
        "start": 5.16,
        "end": 9.58,
        "text": "1.5 goose",
        "words": [{"word": ".5", "start": 5.16, "end": 9.58}],
    }
    repaired = _repair_segment_words(seg)
    assert repaired[0][1] - repaired[0][0] <= MAX_WORD_DUR + 0.01


def test_build_speech_cuts_no_midword_split_thai() -> None:
    """Thai Whisper splits characters with large inter-char gaps — must NOT split mid-word."""
    # Mirrors the actual transcript.json bug: "ปันดับแรก" split because
    # " ป"(7.8-8.3) → "ั"(9.18) gap = 0.88s > old WORD_GAP_THRESHOLD (0.35s).
    segments = [
        {
            "start": 6.1,
            "end": 9.88,
            "text": "แต่งหน้ากันจากฟินแน่ ปันดับแรก",
            "words": [
                {"word": "แต", "start": 6.1, "end": 6.34},
                {"word": "่งหน้ากันจากฟินแน่", "start": 6.34, "end": 7.68},
                # Large gap here simulating Thai character-level timestamps:
                {"word": " ป", "start": 7.8, "end": 8.3},
                {"word": "ัน", "start": 9.18, "end": 9.44},   # 0.88s gap after " ป"
                {"word": "ดับแรก", "start": 9.44, "end": 9.88},
            ],
        },
        {
            "start": 9.88,
            "end": 10.92,
            "text": "โอ้ว มายกอด",
            "words": [
                {"word": "โอ้ว", "start": 9.88, "end": 10.42},
                {"word": "มายกอด", "start": 10.48, "end": 10.92},
            ],
        },
    ]
    cuts = build_speech_cuts(segments, source_duration=45.0)
    # Both segments close together (0s gap) → merged into ONE cut
    assert len(cuts) == 1, f"Expected 1 cut, got {len(cuts)}: {cuts}"
    # Cut must span all speech — not end at 8.8s (the old bug)
    assert cuts[0]["out"] > 10.0, f"Cut ends too early at {cuts[0]['out']}s — mid-word split"


def test_build_speech_cuts_drops_hallucinated_micro_segment() -> None:
    segments = [
        {
            "start": 5.1,
            "end": 5.16,
            "text": "noise",
            "words": [
                {"word": "x", "start": 5.1, "end": 5.1},
                {"word": "y", "start": 5.1, "end": 5.16},
            ],
        },
        {
            "start": 20.0,
            "end": 23.0,
            "text": "วันนี้มารีวิวครีมตัวนี้เลยนะครับ",
            "words": [
                {"word": "วันนี้", "start": 20.0, "end": 20.6},
                {"word": "มารีวิว", "start": 20.6, "end": 21.2},
                {"word": "ครีม", "start": 21.2, "end": 21.8},
                {"word": "ตัวนี้", "start": 21.8, "end": 22.4},
                {"word": "เลย", "start": 22.4, "end": 22.8},
                {"word": "นะครับ", "start": 22.8, "end": 23.0},
            ],
        },
    ]
    cuts = build_speech_cuts(segments)
    assert len(cuts) == 1
    assert cuts[0]["in"] >= 19.7  # segment.start=20.0 minus WORD_LEAD_IN padding


def test_is_likely_continuation_noun_phrase() -> None:
    assert is_likely_continuation(
        "วันนี้มารีวิวครีม",
        "ตัวนี้ดีมาก",
        gap_sec=0.8,
    )


def test_is_likely_continuation_not_after_long_pause() -> None:
    assert not is_likely_continuation(
        "วันนี้มารีวิวครีม",
        "ตัวนี้ดีมาก",
        gap_sec=3.0,
    )


def test_cascade_filter_drops_orphan_continuation() -> None:
    blocks = [
        {"id": 0, "text": "วันนี้มารีวิวครีม", "gap_from_prev_sec": None, "likely_continuation": False},
        {"id": 1, "text": "ตัวนี้ดีมาก", "gap_from_prev_sec": 0.6, "likely_continuation": True},
        {"id": 2, "text": "ราคาไม่แพง", "gap_from_prev_sec": 2.0, "likely_continuation": False},
    ]
    # Claude dropped block 0 but kept 1 — block 1 is mid-sentence orphan
    filtered = cascade_filter_keep_ids([1, 2], blocks)
    assert filtered == [2]


def test_select_speech_cuts_by_ids_applies_cascade() -> None:
    speech_cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 3.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 3.5, "out": 5.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 8.0, "out": 10.0, "label": "speech"},
    ]
    blocks = build_speech_blocks(
        speech_cuts,
        [
            {"start": 0.0, "end": 3.0, "text": "วันนี้มารีวิวครีม", "words": []},
            {"start": 3.5, "end": 5.0, "text": "ตัวนี้ดีมาก", "words": []},
            {"start": 8.0, "end": 10.0, "text": "ราคาไม่แพง", "words": []},
        ],
    )
    kept = select_speech_cuts_by_ids(speech_cuts, [1, 2], blocks)
    assert len(kept) == 1
    assert kept[0]["in"] == 8.0


def test_resnap_selected_cuts_expands_join_lead() -> None:
    """After AI jump, second block should start earlier than raw cut.in."""
    segments = [
        {"start": 0.0, "end": 3.0, "text": "วันนี้มารีวิวครีม", "words": [
            {"word": "วันนี้", "start": 0.3, "end": 0.8},
            {"word": "มารีวิว", "start": 0.8, "end": 1.4},
            {"word": "ครีม", "start": 1.4, "end": 2.0},
        ]},
        {"start": 10.0, "end": 13.0, "text": "ราคาไม่แพงมาก", "words": [
            {"word": "ราคา", "start": 10.2, "end": 10.8},
            {"word": "ไม่แพง", "start": 10.8, "end": 11.4},
            {"word": "มาก", "start": 11.4, "end": 12.0},
        ]},
    ]
    raw_cuts = [
        {"type": "cut", "source": "clip0", "in": 10.0, "out": 13.0, "label": "speech"},
    ]
    resnapped = resnap_selected_cuts(raw_cuts, segments, source_duration=60.0)
    assert len(resnapped) == 1
    assert resnapped[0]["in"] < 10.0  # join lead pulls before Whisper segment.start
    assert resnapped[0]["out"] > 12.0 + WORD_TAIL - 0.05




def test_trim_range_to_segment_budget_never_splits_segment() -> None:
    segments = [
        {"start": 0.0, "end": 5.0, "text": "a"},
        {"start": 5.5, "end": 12.0, "text": "b"},
        {"start": 12.5, "end": 20.0, "text": "c"},
    ]
    lo, hi = trim_range_to_segment_budget(segments, 0.0, 20.0, 8.0, prefer="start")
    assert lo == 0.0
    assert hi == 5.0  # first whole segment only




def test_split_cuts_on_internal_silence() -> None:
    segments = [
        {"start": 10.0, "end": 12.0, "text": "part one", "words": [{"word": "part", "start": 10.0, "end": 12.0}]},
        {"start": 20.0, "end": 23.0, "text": "part two", "words": [{"word": "two", "start": 20.0, "end": 23.0}]},
    ]
    cuts = [{"type": "cut", "source": "clip0", "in": 9.5, "out": 24.0, "label": "speech"}]
    out = split_cuts_on_internal_silence(cuts, segments, max_gap_sec=2.0)
    assert len(out) == 2
    assert out[0]["out"] <= 13.0
    assert out[1]["in"] >= 19.0




def test_trim_speech_cuts_to_budget_slices_oversized_blocks() -> None:
    from packages.video.timeline import trim_speech_cuts_to_budget

    speech_cuts = [
        {"type": "cut", "source": "clip0", "in": 224.0, "out": 526.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 569.0, "out": 572.5, "label": "conclusion"},
    ]
    trimmed = trim_speech_cuts_to_budget(speech_cuts, 51.0)
    assert 45.0 <= cuts_duration(trimmed) <= 51.5
    assert len(trimmed) >= 2
    assert trimmed[0]["in"] == 224.0
    assert trimmed[-1]["out"] == 572.5


def test_apply_semantic_dedupe_plan() -> None:
    cuts = [
        {"type": "cut", "source": "clip0", "in": 0.0, "out": 5.0, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 10.0, "out": 15.0, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 30.0, "out": 35.0, "label": "speech"},
    ]
    segments = [
        {"start": 0.0, "end": 5.0, "text": "วันนี้มารีวิวครีมตัวนี้"},
        {"start": 10.0, "end": 15.0, "text": "ฟีเจอร์แรกคือความชุ่มชื้น"},
        {"start": 30.0, "end": 35.0, "text": "วันนี้จะมารีวิวครีมนี้ให้ดู"},
    ]
    parsed = {
        "duplicate_groups": [
            {"keep": 0, "remove": [2], "reason": "same intro different wording"},
        ],
    }
    out = apply_semantic_dedupe_plan(cuts, segments, parsed)
    assert len(out) == 2
    assert out[0]["in"] == 0.0


def test_enforce_cuts_budget_after_resnap_expansion() -> None:
    """Resnap padding can inflate planned duration — final pass must honor target."""
    segments = [
        {"start": 0.0, "end": 8.0, "text": "opening hook here", "words": [
            {"word": "opening", "start": 0.0, "end": 1.0},
            {"word": "hook", "start": 1.0, "end": 2.0},
            {"word": "here", "start": 2.0, "end": 7.5},
        ]},
        {"start": 12.0, "end": 22.0, "text": "middle feature talk", "words": [
            {"word": "middle", "start": 12.0, "end": 14.0},
            {"word": "feature", "start": 14.0, "end": 18.0},
            {"word": "talk", "start": 18.0, "end": 21.5},
        ]},
        {"start": 28.0, "end": 38.0, "text": "another demo section", "words": [
            {"word": "another", "start": 28.0, "end": 30.0},
            {"word": "demo", "start": 30.0, "end": 34.0},
            {"word": "section", "start": 34.0, "end": 37.5},
        ]},
        {"start": 45.0, "end": 55.0, "text": "closing call to action", "words": [
            {"word": "closing", "start": 45.0, "end": 47.0},
            {"word": "call", "start": 47.0, "end": 50.0},
            {"word": "action", "start": 50.0, "end": 54.5},
        ]},
    ]
    planned = [
        {"type": "cut", "source": "clip0", "in": 0.5, "out": 7.5, "label": "opening"},
        {"type": "cut", "source": "clip0", "in": 12.5, "out": 21.5, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 28.5, "out": 37.5, "label": "speech"},
        {"type": "cut", "source": "clip0", "in": 45.5, "out": 54.5, "label": "conclusion"},
    ]
    expanded = resnap_selected_cuts(planned, segments, source_duration=60.0)
    assert cuts_duration(expanded) > 30.0

    trimmed = enforce_cuts_budget(expanded, segments, 30.0)
    assert cuts_duration(trimmed) <= 30.15
    assert trimmed[0]["label"] == "opening"
    assert trimmed[-1]["label"] == "conclusion"


def test_annotate_dub_script_output_times() -> None:
    script = {
        "segments": [
            {"order": 1, "sourceIn": 62.0, "sourceOut": 67.0, "durationSec": 5.0},
            {"order": 2, "sourceIn": 72.0, "sourceOut": 77.0, "durationSec": 5.0},
            {"order": 3, "sourceIn": 243.0, "sourceOut": 248.0, "durationSec": 5.0},
        ],
    }
    out = annotate_dub_script_output_times(script)
    segs = out["segments"]
    assert segs[0]["outputIn"] == 0.0
    assert segs[0]["outputOut"] == 5.0
    assert segs[1]["outputIn"] == 5.0
    assert segs[2]["outputOut"] == 15.0
    assert out["totalEstimatedSec"] == 15


def test_normalize_dub_montage_groups() -> None:
    script = {
        "segments": [
            {
                "order": 1,
                "voiceoverLineId": 1,
                "sourceIn": 0.0,
                "sourceOut": 3.0,
                "voiceoverScript": "hook line",
            },
            {
                "order": 2,
                "voiceoverLineId": 2,
                "sourceIn": 10.0,
                "sourceOut": 10.6,
                "voiceoverScript": "demo montage",
            },
            {
                "order": 3,
                "voiceoverLineId": 2,
                "sourceIn": 12.0,
                "sourceOut": 13.2,
            },
        ],
    }
    out = normalize_dub_edit_script(script)
    segs = out["segments"]
    assert segs[1]["voiceoverScript"] == "demo montage"
    assert segs[2]["voiceoverScript"] == "demo montage"
    assert segs[1]["voiceoverLineOutputIn"] == segs[1]["outputIn"]
    assert segs[2]["voiceoverLineOutputOut"] == segs[2]["outputOut"]
    assert segs[1]["durationSec"] >= 0.35
    assert out["totalEstimatedSec"] == int(round(segs[-1]["outputOut"]))


def test_normalize_dub_backward_compat_single_cut() -> None:
    script = {
        "segments": [
            {
                "order": 1,
                "sourceIn": 1.0,
                "sourceOut": 4.0,
                "durationSec": 3.0,
                "voiceoverScript": "line one",
            },
            {
                "order": 2,
                "sourceIn": 5.0,
                "sourceOut": 8.0,
                "durationSec": 3.0,
                "voiceoverScript": "line two",
            },
        ],
    }
    out = normalize_dub_edit_script(script)
    segs = out["segments"]
    assert segs[0]["voiceoverLineId"] == 1
    assert segs[1]["voiceoverLineId"] == 2
    assert segs[0]["voiceoverLineOutputIn"] == 0.0
    assert segs[1]["voiceoverLineOutputIn"] == 3.0
