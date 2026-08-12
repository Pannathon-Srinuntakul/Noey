"""ElevenLabs Scribe transcript assembly — the silence-cut arithmetic.

Every test here works on a canned Scribe response, so the whole path from raw
tokens to the ``silence_gaps`` the planner consumes is covered without a network
call. The Thai fixtures matter most: Scribe emits no ``spacing`` tokens for Thai,
so anything that derives gaps or text from them would break on the real language
this project runs on.
"""

from __future__ import annotations

import struct
import wave

import pytest

from packages.video.elevenlabs_stt import (
    build_segments,
    build_silence_gaps,
    build_stt_fields,
    dominant_speaker,
    extract_tokens,
    offset_items,
    raw_pcm_from_wav,
)


def _word(text: str, start: float, end: float, **extra) -> dict:
    """One Scribe ``type="word"`` token — a grapheme cluster on Thai, not a word."""
    return {"type": "word", "text": text, "start": start, "end": end, **extra}


def _graphemes(pieces: list[tuple[str, float, float]], **extra) -> list[dict]:
    return [_word(t, s, e, **extra) for t, s, e in pieces]


# "แต่งหน้ากันจ้ะ" exactly as a real Scribe response splits it (probe, 2026-08-11).
THAI_PIECES = [
    ("แ", 6.28, 6.30), ("ต่", 6.30, 6.42), ("ง", 6.42, 6.52),
    ("ห", 6.52, 6.54), ("น้", 6.54, 6.66), ("า", 6.66, 6.70),
    ("กั", 6.70, 6.78), ("น", 6.78, 6.88),
    ("จ้", 6.88, 7.00), ("ะ", 7.00, 7.10),
]


def _spacing(start: float, end: float) -> dict:
    return {"type": "spacing", "text": " ", "start": start, "end": end}


def _event(text: str, start: float, end: float) -> dict:
    return {"type": "audio_event", "text": text, "start": start, "end": end}


# ── request fields ────────────────────────────────────────────────────────────


def _fields(**over) -> dict[str, str]:
    base = dict(
        model_id="scribe_v2",
        language="th",
        granularity="character",
        no_verbatim=True,
        tag_audio_events=True,
        diarize=False,
        num_speakers=None,
        keyterms=None,
        file_format="pcm_s16le_16",
        seed=None,
    )
    base.update(over)
    return build_stt_fields(**base)  # type: ignore[arg-type]


def test_booleans_serialize_as_lowercase_strings():
    fields = _fields()
    assert fields["no_verbatim"] == "true"
    assert fields["diarize"] == "false"
    assert all(isinstance(v, str) for v in fields.values())


def test_language_omitted_when_blank_so_scribe_autodetects():
    assert "language_code" not in _fields(language="")


def test_num_speakers_only_sent_alongside_diarize():
    assert "num_speakers" not in _fields(diarize=False, num_speakers=3)
    assert _fields(diarize=True, num_speakers=3)["num_speakers"] == "3"


def test_keyterms_json_encoded_thai_unescaped_and_trimmed():
    fields = _fields(keyterms=["เซรั่ม", "  ", "x" * 60])
    assert "เซรั่ม" in fields["keyterms"]  # ensure_ascii=False
    assert "\\u" not in fields["keyterms"]
    assert '"' + "x" * 50 + '"' in fields["keyterms"]  # capped at 50 chars
    assert fields["keyterms"].count(",") == 1  # blank entry dropped


def test_keyterms_field_absent_when_none_supplied():
    assert "keyterms" not in _fields(keyterms=[])


def test_seed_is_sent_so_a_rerun_cuts_the_same_way():
    assert _fields(seed=1)["seed"] == "1"


def test_seed_omitted_when_unset():
    assert "seed" not in _fields(seed=None)


def test_temperature_is_never_sent():
    # Omitted on purpose: Scribe then uses the value tuned for the model (~0).
    assert "temperature" not in _fields()


# ── WAV → raw PCM ─────────────────────────────────────────────────────────────


def _write_wav(path, *, channels=1, width=2, rate=16000, frames=100):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 1234) * frames * channels)


def test_raw_pcm_strips_the_riff_header(tmp_path):
    wav = tmp_path / "audio_000.wav"
    _write_wav(wav, frames=100)
    pcm = raw_pcm_from_wav(wav)
    assert pcm is not None
    assert len(pcm) == 200  # 100 frames x 16-bit mono, no 44-byte header
    assert len(pcm) < wav.stat().st_size


@pytest.mark.parametrize("kwargs", [{"channels": 2}, {"rate": 44100}, {"width": 1}])
def test_raw_pcm_declines_anything_but_16bit_mono_16k(tmp_path, kwargs):
    wav = tmp_path / "odd.wav"
    _write_wav(wav, **kwargs)
    assert raw_pcm_from_wav(wav) is None


def test_raw_pcm_declines_a_non_wav_file(tmp_path):
    path = tmp_path / "not.wav"
    path.write_bytes(b"definitely not RIFF")
    assert raw_pcm_from_wav(path) is None


# ── response → tokens ─────────────────────────────────────────────────────────


def test_thai_graphemes_are_merged_back_into_words():
    words, _ = extract_tokens({"words": _graphemes(THAI_PIECES)}, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["แต่งหน้า", "กัน", "จ้ะ"]


def test_merged_word_spans_first_to_last_grapheme():
    words, _ = extract_tokens({"words": _graphemes(THAI_PIECES)}, min_logprob=-2.0)
    assert (words[0]["start"], words[0]["end"]) == (6.28, 6.7)   # แ … า
    assert (words[-1]["start"], words[-1]["end"]) == (6.88, 7.1)  # จ้ … ะ


def test_low_confidence_words_are_dropped():
    resp = {"words": [
        _word("สวัสดี", 0.0, 0.5, logprob=-0.1),
        {"type": "spacing", "text": " ", "start": 0.5, "end": 0.55},
        _word("ครับ", 0.6, 0.9, logprob=-5.0),
    ]}
    words, _ = extract_tokens(resp, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["สวัสดี"]


def test_a_weak_grapheme_takes_its_whole_word_down_not_a_hole_in_it():
    # Filtering pieces instead of words would leave "แต่หน้า" — a word that was
    # never said. The weakest piece decides the fate of the word it belongs to.
    pieces = _graphemes(THAI_PIECES, logprob=-0.1)
    pieces[1]["logprob"] = -9.0  # "ต่", inside "แต่งหน้า"
    words, _ = extract_tokens({"words": pieces}, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["กัน", "จ้ะ"]


def test_zero_duration_pieces_do_not_survive_as_words():
    # Scribe emits these over noise (probe: four pieces at 39.86 -> 39.86).
    words, _ = extract_tokens({"words": _graphemes([("อ", 39.86, 39.86)])}, min_logprob=-2.0)
    assert words == []


def test_words_without_logprob_survive():
    resp = {"words": [_word("สวัสดี", 0.0, 0.5)]}
    words, _ = extract_tokens(resp, min_logprob=-2.0)
    assert len(words) == 1


def test_audio_events_are_separated_from_words():
    resp = {"words": [_word("ฮ่า", 0.0, 0.4), _event("(laughter)", 1.0, 2.0)]}
    words, events = extract_tokens(resp, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["ฮ่า"]
    assert events == [{"text": "(laughter)", "start": 1.0, "end": 2.0}]


def test_tokens_without_timestamps_are_skipped():
    resp = {"words": [
        {"type": "word", "text": "x", "start": None, "end": None},
        _word("ok", 0.0, 0.3),
    ]}
    words, _ = extract_tokens(resp, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["ok"]


def test_character_timings_tighten_the_word_envelope():
    resp = {"words": [dict(
        _word("สวัสดี", 0.0, 1.0),
        characters=[{"text": "ส", "start": 0.12, "end": 0.4},
                    {"text": "ดี", "start": 0.4, "end": 0.80}],
    )]}
    words, _ = extract_tokens(resp, min_logprob=-2.0)
    assert (words[0]["start"], words[0]["end"]) == (0.12, 0.8)


def test_word_bounds_survive_unusable_character_timings():
    resp = {"words": [dict(
        _word("สวัสดี", 0.0, 1.0),
        characters=[{"text": "ส", "start": None, "end": None}],
    )]}
    words, _ = extract_tokens(resp, min_logprob=-2.0)
    assert (words[0]["start"], words[0]["end"]) == (0.0, 1.0)


def test_dominant_speaker_filter_drops_the_bystander():
    resp = {"words": [
        _word("กัน", 0.0, 2.0, speaker_id="speaker_0"),
        {"type": "spacing", "text": " ", "start": 2.0, "end": 2.1},
        _word("noise", 4.5, 4.7, speaker_id="speaker_1"),
    ]}
    assert dominant_speaker(resp["words"]) == "speaker_0"
    words, _ = extract_tokens(resp, min_logprob=-2.0, keep_speaker="speaker_0")
    assert [w["word"] for w in words] == ["กัน"]


def test_dominant_speaker_is_none_without_diarization():
    assert dominant_speaker([_word("ก", 0.0, 1.0)]) is None


# ── tokens → segments ─────────────────────────────────────────────────────────


def test_segments_split_on_a_long_word_gap():
    raw = _graphemes([*THAI_PIECES, ("ค", 9.0, 9.4)])
    words, _ = extract_tokens({"words": raw}, min_logprob=-2.0)
    segments = build_segments(words, raw)
    assert len(segments) == 2
    assert segments[0]["text"] == "แต่งหน้ากันจ้ะ"
    assert (segments[1]["start"], segments[1]["end"]) == (9.0, 9.4)


def test_segment_carries_merged_words_for_captions_not_graphemes():
    raw = _graphemes(THAI_PIECES)
    words, _ = extract_tokens({"words": raw}, min_logprob=-2.0)
    seg = build_segments(words, raw)[0]
    assert [w["word"] for w in seg["words"]] == ["แต่งหน้า", "กัน", "จ้ะ"]
    assert seg["words"][0] == {"word": "แต่งหน้า", "start": 6.28, "end": 6.7}


def test_spacing_tokens_rebuild_spaces_for_space_delimited_languages():
    raw = [_word("hello", 0.0, 0.4), _spacing(0.4, 0.45), _word("world", 0.45, 0.9)]
    words, _ = extract_tokens({"words": raw}, min_logprob=-2.0)
    assert build_segments(words, raw)[0]["text"] == "hello world"


def test_spacing_inside_thai_speech_is_preserved():
    # Real responses put spacing around Latin words embedded in Thai speech,
    # contradicting the docs' claim that Thai has no spacing tokens.
    raw = [*_graphemes(THAI_PIECES), _spacing(7.1, 7.2), _word("God", 7.2, 7.5)]
    words, _ = extract_tokens({"words": raw}, min_logprob=-2.0)
    assert build_segments(words, raw)[0]["text"] == "แต่งหน้ากันจ้ะ God"


def test_a_dropped_word_does_not_drag_its_neighbours_text_along():
    raw = [
        _word("กัน", 0.0, 0.4),
        _spacing(0.4, 0.45),
        _word("มั่ว", 0.45, 0.6, logprob=-9.0),
        _spacing(0.6, 0.65),
        _word("จ้ะ", 0.65, 0.9),
    ]
    words, _ = extract_tokens({"words": raw}, min_logprob=-2.0)
    assert build_segments(words, raw)[0]["text"] == "กัน จ้ะ"


def test_no_words_yields_no_segments():
    assert build_segments([], []) == []


# ── silence gaps ──────────────────────────────────────────────────────────────


def _segs(*spans) -> list[dict]:
    return [
        {"start": s, "end": e, "text": "x", "words": [{"word": "x", "start": s, "end": e}]}
        for s, e in spans
    ]


def test_no_silence_survives_on_its_own():
    assert build_silence_gaps(_segs((0.0, 2.0), (8.0, 10.0)), []) == []


@pytest.mark.parametrize("tag", [
    "[เสียงเพลง]",                # background music
    "[เสียงโฆษณาจากโทรทัศน์]",     # a television in the next room
    "[เสียงวางแปรง]",              # a product being set down
    "(laughter)",
])
def test_no_audio_event_rescues_a_silent_span(tag):
    # Every bracketed tag is non-speech, and non-speech is noise in this cut.
    # Probe runs produced all four of these on real footage.
    assert build_silence_gaps(_segs((0.0, 2.0), (8.0, 10.0)), [_event(tag, 4.0, 6.0)]) == []


def test_an_overlong_word_is_clamped_not_dropped():
    # Probe: one merged "word" spanned 12.2 s; its end would have set its
    # segment's end and dragged the whole void into the cut.
    words, _ = extract_tokens({"words": _graphemes([("โอ๊ย", 5.0, 17.2)])}, min_logprob=-2.0)
    assert [w["word"] for w in words] == ["โอ๊ย"]
    assert words[0]["end"] == 7.0


def test_a_single_segment_has_no_gaps():
    assert build_silence_gaps(_segs((0.0, 2.0)), [_event("(laughter)", 3.0, 4.0)]) == []


# ── clip offsets ──────────────────────────────────────────────────────────────


def test_offset_shifts_segment_and_word_timings_together():
    segs = _segs((1.0, 2.0))
    shifted = offset_items(segs, 10.0, ("start", "end"))
    assert (shifted[0]["start"], shifted[0]["end"]) == (11.0, 12.0)
    assert shifted[0]["words"][0] == {"word": "x", "start": 11.0, "end": 12.0}


def test_offset_does_not_mutate_the_input():
    segs = _segs((1.0, 2.0))
    offset_items(segs, 10.0, ("start", "end"))
    assert segs[0]["start"] == 1.0
    assert segs[0]["words"][0]["start"] == 1.0
