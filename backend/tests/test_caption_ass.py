"""Unit tests for ASS karaoke caption builder."""

import pytest

from packages.video.caption import (
    _ass_time,
    _hex_to_ass_color,
    build_ass_captions,
    build_ass_karaoke,
    redistribute_line_words,
    remap_words_to_output,
    resolve_caption_style,
)


def test_ass_time_zero():
    assert _ass_time(0.0) == "0:00:00.00"


def test_ass_time_basic():
    assert _ass_time(3.5) == "0:00:03.50"


def test_ass_time_minutes():
    assert _ass_time(65.25) == "0:01:05.25"


def test_ass_time_negative_clamp():
    assert _ass_time(-1.0) == "0:00:00.00"


def test_build_ass_header_always_present():
    result = build_ass_karaoke([])
    assert "[Script Info]" in result
    assert "[V4+ Styles]" in result
    assert "[Events]" in result


def test_build_ass_single_word():
    words = [{"word": "สวัสดี", "start": 1.0, "end": 1.5}]
    result = build_ass_karaoke(words)
    assert "\\kf50" in result   # 0.5s = 50 cs
    assert "สวัสดี" in result
    lines = [l for l in result.splitlines() if l.startswith("Dialogue:")]
    assert len(lines) == 1


def test_build_ass_three_words_one_line():
    words = [
        {"word": "A", "start": 0.0, "end": 0.3},
        {"word": "B", "start": 0.3, "end": 0.6},
        {"word": "C", "start": 0.6, "end": 1.0},
    ]
    result = build_ass_karaoke(words)
    lines = [l for l in result.splitlines() if l.startswith("Dialogue:")]
    assert len(lines) == 1


def test_build_ass_four_words_two_lines():
    words = [
        {"word": "A", "start": 0.0, "end": 0.3},
        {"word": "B", "start": 0.3, "end": 0.6},
        {"word": "C", "start": 0.6, "end": 0.9},
        {"word": "D", "start": 0.9, "end": 1.2},
    ]
    result = build_ass_karaoke(words)
    lines = [l for l in result.splitlines() if l.startswith("Dialogue:")]
    assert len(lines) == 2


def test_karaoke_centiseconds_half_second():
    words = [{"word": "hello", "start": 0.0, "end": 0.5}]
    result = build_ass_karaoke(words)
    assert "\\kf50" in result


def test_karaoke_min_centiseconds():
    # word with 0 duration — group end==start → skip (no dialogue line)
    words = [{"word": "x", "start": 1.0, "end": 1.0}]
    result = build_ass_karaoke(words)
    lines = [l for l in result.splitlines() if l.startswith("Dialogue:")]
    assert len(lines) == 0


def test_remap_empty():
    assert remap_words_to_output([], [], {}) == []


def test_remap_single_clip_basic():
    words = [{"word": "test", "start": 5.5, "end": 6.0}]
    cuts = [{"source": "clip0", "in": 5.0, "out": 10.0}]
    offsets = {"clip0": 0.0}
    result = remap_words_to_output(words, cuts, offsets)
    assert len(result) == 1
    assert abs(result[0]["start"] - 0.5) < 0.01
    assert abs(result[0]["end"] - 1.0) < 0.01
    assert result[0]["word"] == "test"


def test_remap_word_outside_cut():
    words = [{"word": "outside", "start": 15.0, "end": 16.0}]
    cuts = [{"source": "clip0", "in": 5.0, "out": 10.0}]
    offsets = {"clip0": 0.0}
    assert remap_words_to_output(words, cuts, offsets) == []


def test_remap_word_straddles_cut_boundary():
    # word starts before cut, ends inside — clamp to cut start
    words = [{"word": "straddle", "start": 4.5, "end": 5.5}]
    cuts = [{"source": "clip0", "in": 5.0, "out": 10.0}]
    offsets = {"clip0": 0.0}
    result = remap_words_to_output(words, cuts, offsets)
    assert len(result) == 1
    assert result[0]["start"] == pytest.approx(0.0, abs=0.01)
    assert result[0]["end"] == pytest.approx(0.5, abs=0.01)


def test_remap_multi_clip():
    # clip0 lasts 20s; clip1 starts at abs 20s
    words = [{"word": "fromclip1", "start": 22.0, "end": 22.5}]
    cuts = [
        {"source": "clip0", "in": 0.0, "out": 10.0},
        {"source": "clip1", "in": 2.0, "out": 5.0},
    ]
    offsets = {"clip0": 0.0, "clip1": 20.0}
    # clip1 cut abs window = [20+2, 20+5] = [22, 25]; output_offset after clip0 cut = 10.0
    # out_start = 10.0 + (22.0 - 22.0) = 10.0
    result = remap_words_to_output(words, cuts, offsets)
    assert len(result) == 1
    assert abs(result[0]["start"] - 10.0) < 0.01


# ── static / word_pop / typewriter modes ─────────────────────────────────────

_ABC_WORDS = [
    {"word": "A", "start": 0.0, "end": 0.3},
    {"word": "B", "start": 0.3, "end": 0.6},
    {"word": "C", "start": 0.6, "end": 1.0},
]


def _dialogue_lines(ass: str) -> list[str]:
    return [l for l in ass.splitlines() if l.startswith("Dialogue:")]


def test_static_thai_words_join_without_spaces():
    # Thai writing has no inter-word spaces — Whisper only splits words for its
    # own alignment, so joining them with a plain " " reads unnaturally
    # ("แต่ง หน้า กัน" instead of "แต่งหน้ากัน").
    words = [
        {"word": "แต่ง", "start": 0.0, "end": 0.3},
        {"word": "หน้า", "start": 0.3, "end": 0.6},
        {"word": "กัน", "start": 0.6, "end": 0.9},
    ]
    result = build_ass_captions(words, mode="static")
    lines = _dialogue_lines(result)
    assert len(lines) == 1
    assert lines[0].endswith(",แต่งหน้ากัน")


def test_static_mixed_thai_and_latin_keeps_space_at_boundary():
    words = [
        {"word": "TikTok", "start": 0.0, "end": 0.3},
        {"word": "สุดปัง", "start": 0.3, "end": 0.6},
    ]
    result = build_ass_captions(words, mode="static")
    lines = _dialogue_lines(result)
    assert lines[0].endswith(",TikTok สุดปัง")


def test_static_one_line_no_animation_tags():
    result = build_ass_captions(_ABC_WORDS, mode="static")
    lines = _dialogue_lines(result)
    assert len(lines) == 1
    assert "A B C" in lines[0]
    assert "\\k" not in lines[0]


def test_static_four_words_two_lines():
    words = _ABC_WORDS + [{"word": "D", "start": 1.0, "end": 1.3}]
    result = build_ass_captions(words, mode="static")
    assert len(_dialogue_lines(result)) == 2


def test_static_line_spans_full_group():
    result = build_ass_captions(_ABC_WORDS, mode="static")
    lines = _dialogue_lines(result)
    assert "0:00:00.00" in lines[0]
    assert "0:00:01.00" in lines[0]


def test_word_pop_line_count_matches_word_count():
    result = build_ass_captions(_ABC_WORDS, mode="word_pop")
    assert len(_dialogue_lines(result)) == 3


def test_word_pop_cumulative_text():
    result = build_ass_captions(_ABC_WORDS, mode="word_pop")
    lines = _dialogue_lines(result)
    assert lines[0].endswith(",A")
    assert lines[1].endswith(",A B")
    assert lines[2].endswith(",A B C")


def test_word_pop_last_segment_holds_to_chunk_end():
    result = build_ass_captions(_ABC_WORDS, mode="word_pop")
    lines = _dialogue_lines(result)
    assert "0:00:01.00" in lines[2]  # ends at chunk end (C's own end)


def test_typewriter_reveals_characters_within_word():
    words = [{"word": "AB", "start": 0.0, "end": 0.4}]
    result = build_ass_captions(words, mode="typewriter")
    lines = _dialogue_lines(result)
    assert len(lines) == 2
    assert lines[0].endswith(",A")
    assert lines[1].endswith(",AB")


def test_typewriter_cumulative_across_words():
    words = [
        {"word": "Hi", "start": 0.0, "end": 0.2},
        {"word": "Yo", "start": 0.2, "end": 0.4},
    ]
    result = build_ass_captions(words, mode="typewriter")
    lines = _dialogue_lines(result)
    assert len(lines) == 4
    assert lines[-1].endswith(",Hi Yo")


def test_build_ass_captions_empty_returns_header_only():
    result = build_ass_captions([], mode="static")
    assert "[Events]" in result
    assert "Dialogue:" not in result


def test_build_ass_captions_unknown_mode_falls_back_to_static():
    result = build_ass_captions(_ABC_WORDS, mode="not_a_real_mode")
    lines = _dialogue_lines(result)
    assert len(lines) == 1
    assert "\\k" not in lines[0]


def test_redistribute_line_words_even_spacing():
    result = redistribute_line_words("a b c", 0.0, 3.0)
    assert len(result) == 3
    assert result[0] == {"word": "a", "start": 0.0, "end": 1.0}
    assert result[1] == {"word": "b", "start": 1.0, "end": 2.0}
    assert result[2] == {"word": "c", "start": 2.0, "end": 3.0}


def test_redistribute_line_words_empty_text():
    assert redistribute_line_words("", 0.0, 1.0) == []


def test_build_ass_captions_with_edited_caption_line():
    # user edited text — no matching original words → falls back to redistribution
    caption_lines = [{"id": "1", "text": "X Y", "start": 0.0, "end": 1.0}]
    result = build_ass_captions(_ABC_WORDS, mode="static", caption_lines=caption_lines)
    lines = _dialogue_lines(result)
    assert len(lines) == 1
    assert "X Y" in lines[0]


def test_build_ass_captions_with_untouched_caption_line_keeps_original_timing():
    # text matches original words exactly → uses original per-word timestamps
    caption_lines = [{"id": "1", "text": "A B C", "start": 0.0, "end": 1.0}]
    result = build_ass_captions(_ABC_WORDS, mode="word_pop", caption_lines=caption_lines)
    lines = _dialogue_lines(result)
    assert len(lines) == 3  # word_pop still expands per-word from matched originals


def test_build_ass_captions_deleted_line_produces_no_dialogue():
    # simulates a deleted caption line — simply not included in caption_lines
    result = build_ass_captions(_ABC_WORDS, mode="static", caption_lines=[])
    lines = _dialogue_lines(result)
    assert len(lines) == 0


def test_hex_to_ass_color_white():
    assert _hex_to_ass_color("#FFFFFF") == "&H00FFFFFF"


def test_hex_to_ass_color_red_is_bgr_order():
    assert _hex_to_ass_color("#FF0000") == "&H000000FF"


def test_hex_to_ass_color_invalid_falls_back_to_white():
    assert _hex_to_ass_color("nonsense") == "&H00FFFFFF"


def test_resolve_caption_style_defaults():
    style, mode = resolve_caption_style(None)
    assert mode == "static"
    assert style["fontname"] == "Kanit"
    assert style["outline"] == "&H00000000"


def test_resolve_caption_style_custom():
    style, mode = resolve_caption_style(
        {"font": "prompt", "mode": "typewriter", "color": "#00FF00", "border_color": "#FFFFFF", "size": 90}
    )
    assert mode == "typewriter"
    assert style["fontname"] == "Prompt"
    assert style["primary"] == "&H0000FF00"
    assert style["outline"] == "&H00FFFFFF"
    assert style["fontsize"] == 90
