"""Unit tests for ASS karaoke caption builder."""

import pytest

from packages.video.caption import (
    _ass_time,
    build_ass_karaoke,
    remap_words_to_output,
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
