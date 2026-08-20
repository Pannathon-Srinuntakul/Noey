"""R17 speech-mode selection: the four weak-highlight gates live in code, not
prose — these tests pin them so a prompt tweak can never quietly disable one.
"""

from __future__ import annotations

import sys

import pytest

from packages.video.speech_select import (
    CONTINUITY_BLOCK,
    DEFAULT_SPEECH_CUT_PROSE,
    HIGHLIGHT_RUNAWAY_CEILING,
    MIN_HIGHLIGHT_SCORE,
    MIN_PIECE_SEC,
    SPEECH_GAP_THRESHOLD,
    SCHEMA_SPAN_TRIM,
    SPAN_TRIM_SYSTEM,
    SPEECH_HIGHLIGHTS_SYSTEM,
    SPEECH_SCENES_SYSTEM,
    _valid_ranges,
    enforce_piece_shape,
    gate_highlights,
    picks_to_cuts,
    render_transcript,
    tighten_window_cuts,
)


def seg(i: float, o: float, text: str = "พูด", speaker: str | None = None) -> dict:
    s: dict = {
        "start": i,
        "end": o,
        "text": text,
        "words": [
            {"word": text, "start": i, "end": o - 0.05},
        ],
    }
    if speaker:
        s["speaker"] = speaker
    return s


def segments_spanning(total_sec: float, seg_sec: float = 5.0) -> list[dict]:
    out = []
    t = 0.0
    while t + seg_sec <= total_sec:
        out.append(seg(t, t + seg_sec))
        t += seg_sec
    return out


# ── prompt invariants ─────────────────────────────────────────────────────────


def test_prompts_are_new_files_not_dub_ai_edits() -> None:
    # The dub prompts must stay untouched; the speech prompts carry their own
    # continuity block and the scenes prompt keeps the cut-style splice point.
    from packages.video import dub_ai

    assert "Never cut backwards" in CONTINUITY_BLOCK
    assert CONTINUITY_BLOCK in SPEECH_SCENES_SYSTEM
    assert CONTINUITY_BLOCK in SPEECH_HIGHLIGHTS_SYSTEM
    assert "__CUT_STYLE_BLOCK__" in SPEECH_SCENES_SYSTEM
    # mode A has no cut style at all (R17: โหมด A ไม่ใช้เลย)
    assert "__CUT_STYLE_BLOCK__" not in SPEECH_HIGHLIGHTS_SYSTEM
    # and nothing here leaked back into dub_ai
    assert "highlight moments in a long spoken recording" not in dub_ai.DUB_EDIT_SYSTEM_VIDEO


def test_segment_numbers_are_the_contract() -> None:
    for prompt in (SPEECH_SCENES_SYSTEM, SPEECH_HIGHLIGHTS_SYSTEM):
        assert "segFrom" in prompt and "segTo" in prompt
    # The transcript shows numbers the model answers with; seconds are display
    # only and never in MM:SS (the 442-bug family).
    text = render_transcript([seg(0, 5), seg(5, 9, speaker="SPK_1")])
    assert text.splitlines()[0].startswith("#0 ")
    assert "[SPK_1]" in text
    assert ":" not in text.split(")")[0].split("(")[1]  # (0.0s-5.0s), no colons


def test_default_speech_prose_is_not_the_dub_default() -> None:
    from packages.video.dub_ai import DEFAULT_CUT_STYLE_PROSE

    assert DEFAULT_SPEECH_CUT_PROSE != DEFAULT_CUT_STYLE_PROSE
    assert "voiceover" not in DEFAULT_SPEECH_CUT_PROSE.lower()


# ── range validation ──────────────────────────────────────────────────────────


def test_valid_ranges_drops_malformed_and_overlaps() -> None:
    picks = [
        {"segFrom": 5, "segTo": 3},          # inverted
        {"segFrom": -1, "segTo": 2},         # negative
        {"segFrom": 0, "segTo": 2},          # ok
        {"segFrom": 2, "segTo": 4},          # overlaps previous (2 <= 2)
        {"segFrom": 5, "segTo": 90},         # out of range
        {"segFrom": 6, "segTo": 7},          # ok
    ]
    kept = _valid_ranges(picks, segment_count=10)
    assert [(p["segFrom"], p["segTo"]) for p in kept] == [(0, 2), (6, 7)]


# ── the four gates ────────────────────────────────────────────────────────────


def test_gate_score_floor() -> None:
    segs = segments_spanning(600)
    picks = [
        {"segFrom": 0, "segTo": 5, "score": 3, "title": "t", "why": "w"},
        {"segFrom": 10, "segTo": 15, "score": 4, "title": "t", "why": "w"},
    ]
    kept = gate_highlights(picks, segs, source_duration=600)
    assert len(kept) == 1
    assert kept[0]["segFrom"] == 10
    assert MIN_HIGHLIGHT_SCORE == 4


def test_length_is_not_gated() -> None:
    """Owner decision 2026-08-19: no MIN/MAX highlight length. A 10s punchline
    and a 5min explanation are both legitimate; the fixed 20-180s bounds were
    ending highlights instead of the material (3 of 4 landed within 6s of the
    old ceiling on the first real run)."""
    segs = segments_spanning(1200)
    short = {"segFrom": 0, "segTo": 1, "score": 5, "title": "t", "why": "w"}     # ~10s
    mid = {"segFrom": 10, "segTo": 17, "score": 5, "title": "t", "why": "w"}     # ~40s
    long = {"segFrom": 60, "segTo": 120, "score": 5, "title": "t", "why": "w"}   # ~305s
    kept = gate_highlights([short, mid, long], segs, source_duration=1200)
    assert [p["segFrom"] for p in kept] == [0, 10, 60]


def test_count_is_not_gated_but_runaway_is_capped() -> None:
    """No slots-per-minute formula: a dense hour holds more moments than a
    rambling one. The only ceiling left protects the render queue from a
    malformed response, and it is far above any real edit."""
    segs = segments_spanning(960)  # 16 min — the old formula allowed 2
    picks = [
        {"segFrom": i * 6, "segTo": i * 6 + 4, "score": 4, "title": f"t{i}", "why": "w"}
        for i in range(12)
    ]
    kept = gate_highlights(picks, segs, source_duration=960)
    assert len(kept) == 12, "12 valid picks from 16 minutes must all survive"
    assert HIGHLIGHT_RUNAWAY_CEILING >= 50


def test_gate_empty_is_an_error_never_padded() -> None:
    segs = segments_spanning(600)
    weak = [{"segFrom": 0, "segTo": 5, "score": 2, "title": "t", "why": "w"}]
    with pytest.raises(ValueError, match="ไม่มีช่วงที่ฟังจบได้ในตัวเอง"):
        gate_highlights(weak, segs, source_duration=600)


# ── segment → seconds ─────────────────────────────────────────────────────────


def test_picks_to_cuts_uses_word_edges_and_stays_in_bounds() -> None:
    segs = [seg(0.0, 5.0), seg(5.2, 9.8), seg(10.1, 14.9)]
    cuts = picks_to_cuts(
        [{"segFrom": 0, "segTo": 1, "why": "w"}, {"segFrom": 2, "segTo": 2, "why": "w"}],
        segs,
        source_duration=15.0,
    )
    assert len(cuts) == 2
    for c in cuts:
        assert 0.0 <= c["in"] < c["out"] <= 15.0
    # first cut starts at (or snapped near) the first word, not at 0-minus
    assert cuts[0]["in"] >= 0.0
    # ordered forward — never backwards
    assert cuts[0]["out"] <= cuts[1]["in"] + 0.8  # snap window tolerance


# ── the in-window silence cut (owner decision 2026-08-19) ────────────────────


def test_highlight_prompt_counts_substance_not_only_excitement() -> None:
    # "ไฮไลต์ ไม่ได้หมายถึงเฉพาะแค่สิ่งที่น่าตื่นเต้น แต่หมายถึงเนื้อหาสำคัญ ... ทั้งหมด"
    assert "not only the exciting moments" in SPEECH_HIGHLIGHTS_SYSTEM
    assert "important substance" in SPEECH_HIGHLIGHTS_SYSTEM
    # and the picker is told the later passes exist, so it picks whole topics
    # instead of pre-trimming (the failure that made spans narrow)
    assert "<later_passes>" in SPEECH_HIGHLIGHTS_SYSTEM
    assert "choose the WHOLE topic" in SPEECH_HIGHLIGHTS_SYSTEM
    # length/count guidance lives in the prompt now that the code stopped gating
    assert "no minimum and no maximum" in SPEECH_HIGHLIGHTS_SYSTEM
    assert "<how_many>" in SPEECH_HIGHLIGHTS_SYSTEM


def test_window_with_dead_air_is_tightened_not_rejected() -> None:
    """A 200s window whose middle is silence would have failed the old
    raw-window length gate; now the silence-cut inside the window shrinks it
    to its spoken content and it survives with multiple cuts."""
    segs = [
        seg(0.0, 30.0, "ช่วงพูดแรก"),
        seg(30.5, 60.0, "พูดต่อเนื่อง"),
        # 100 seconds of dead air here
        seg(160.0, 200.0, "ช่วงพูดท้าย"),
    ]
    picks = [{"segFrom": 0, "segTo": 2, "score": 5, "title": "t", "why": "w"}]
    kept = gate_highlights(picks, segs, source_duration=210)
    assert len(kept) == 1
    cuts = kept[0]["cuts"]
    assert len(cuts) >= 2  # the silence split the window into separate cuts
    # kept duration is the SPOKEN length, far under the 200s raw window
    assert kept[0]["durationSec"] <= 110
    # and no cut covers the dead air
    for c in cuts:
        assert not (c["in"] > 61.0 and c["out"] < 159.0)


def test_tighten_never_bleeds_outside_the_window() -> None:
    segs = [
        seg(0.0, 10.0, "ก่อนหน้า"),          # not picked
        seg(20.0, 50.0, "เนื้อหาที่เลือก"),
        seg(60.0, 90.0, "เนื้อหาที่เลือกต่อ"),
        seg(100.0, 120.0, "หลังจากนั้น"),     # not picked
    ]
    cuts = tighten_window_cuts(
        {"segFrom": 1, "segTo": 2}, segs, source_duration=130
    )
    assert cuts
    for c in cuts:
        assert c["in"] >= 10.0  # never reaches the unpicked segment before
        assert c["out"] <= 91.0  # nor the one after (small snap tolerance)


def test_speech_cut_uses_its_own_profile_not_the_whisper_defaults() -> None:
    """The tight profile is the whole point: measured on a real 179s podcast
    window, the shared defaults removed 0.0s of 23.8s of silence because
    resnap's SEGMENT_MERGE_GAP (2.5s) re-absorbed every gap the split had just
    made. Pin the wiring so a later refactor cannot quietly fall back."""
    from packages.video.timeline import DEFAULT_PROFILE, SPEECH_PROFILE

    assert SPEECH_PROFILE.segment_merge_gap == 0.3 < DEFAULT_PROFILE.segment_merge_gap
    assert SPEECH_PROFILE.join_tail < DEFAULT_PROFILE.join_tail
    assert SPEECH_PROFILE.head_lookback_sec == 0.0  # Whisper-only repair
    assert SPEECH_GAP_THRESHOLD == 0.5

    # A window whose segments are separated by ~0.7s gaps: the defaults keep it
    # whole, the speech profile actually removes the silence.
    segs = [seg(0.0, 8.0), seg(8.7, 16.0), seg(16.7, 24.0), seg(24.7, 32.0)]
    cuts = tighten_window_cuts(
        {"segFrom": 0, "segTo": 3}, segs, source_duration=40
    )
    kept = sum(c["out"] - c["in"] for c in cuts)
    assert len(cuts) == 4, "0.7s gaps must split, not merge into one block"
    # 2.1s of gap, ~0.25s of pad given back per join: most of it must go. The
    # shared defaults keep all 32.1s; a double-padded chain kept 31.4s.
    assert kept < 31.0, f"silence should be gone, kept {kept}"


# ── piece shape: what the prompt asks for, the code guarantees ───────────────


def test_short_fragments_are_absorbed_not_kept() -> None:
    """A 1.3s fragment lifted out of a paragraph cannot carry a thought — on the
    first real run one of them OPENED a clip ("ไม่ชอบออกกล้อง")."""
    segs = [seg(i * 10.0, i * 10.0 + 8.0) for i in range(8)]
    # piece 2 is a single 8s segment (fine); piece 1 is a sliver
    ranges = [(0, 0), (2, 3), (5, 6)]
    segs[0] = seg(0.0, 1.3)  # make the first piece too short
    out = enforce_piece_shape(ranges, segs)
    assert (0, 0) not in out, "a too-short opening piece must be dropped"
    assert MIN_PIECE_SEC == 4.0


def test_fragment_in_the_middle_merges_backwards() -> None:
    segs = [seg(i * 10.0, i * 10.0 + 8.0) for i in range(6)]
    segs[3] = seg(30.0, 31.0)  # 1s fragment
    out = enforce_piece_shape([(0, 1), (3, 3), (5, 5)], segs)
    # the fragment is swallowed by the piece before it, gap and all
    assert out[0] == (0, 3)
    assert (3, 3) not in out


def test_a_leap_is_flagged_but_never_acted_on() -> None:
    """Owner decision 2026-08-19 (second round): whether a wide jump still
    reads as one conversation is a MEANING question, so it belongs to the
    model. The old code dropped the smaller side — and on a real run that side
    was the setup the model had deliberately kept."""
    segs = [seg(i * 10.0, i * 10.0 + 8.0) for i in range(30)]
    ranges = [(0, 2), (3, 5), (25, 26)]  # last one is ~200s later
    out = enforce_piece_shape(ranges, segs)
    assert out == [(0, 2), (3, 5), (25, 26)], "every kept piece must survive"


def test_seamless_rules_are_in_the_prompt() -> None:
    p = SPAN_TRIM_SYSTEM
    assert "THE OPENING TELLS THEM WHAT THIS IS" in p
    assert "EVERY KEPT RUN IS A WHOLE THOUGHT" in p
    assert "NOTHING POINTS AT WHAT YOU DROPPED" in p
    assert "NO UNEXPLAINED LEAPS" in p
    assert "THE CLIP DELIVERS WHAT IT PROMISES" in p
    assert "look at what comes AFTER your last kept sentence" in p
    assert "stop LATER" in p


def test_story_structure_is_the_frame() -> None:
    """Owner report 2026-08-19: the ruthless prompt deleted whole setups (48 of
    66 sentences in one clip) because nothing scoped the ruthlessness. The
    rewrite frames the job as retelling a SETUP-DEVELOPMENT-PAYOFF story and
    forbids applying the drop-test to a whole part."""
    p = SPAN_TRIM_SYSTEM
    assert "SETUP" in p and "DEVELOPMENT" in p and "PAYOFF" in p
    assert "NEVER apply the test to a whole part" in p
    assert "the story wins" in p


def test_selector_is_told_to_sweep_the_whole_recording() -> None:
    """Owner decision 2026-08-19: the selector must return every distinct
    stretch worth watching, thirty if there are thirty. The old wording carried
    numeric anchors ("a dozen", "two") that read as a target range — real runs
    came back with 5-6 picks from 70 minutes."""
    p = SPEECH_HIGHLIGHTS_SYSTEM
    assert "NO upper limit" in p
    assert "Never stop early" in p
    assert "<distinct>" in p
    # the anchors that were biasing the count are gone
    assert "a dozen" not in p
    # and no count gate ever came back to the code
    assert not hasattr(sys.modules["packages.video.speech_select"], "MAX_HIGHLIGHTS")


def test_story_and_both_edges_are_required_output() -> None:
    """A required key cannot be waved through — the model must name the story
    before trimming it and justify both edges after. On a real run the answer
    to a clip's own title sat in the sentences right after the cut."""
    props = SCHEMA_SPAN_TRIM["properties"]
    assert set(SCHEMA_SPAN_TRIM["required"]) == {"story", "verdicts", "opening", "closing"}
    assert set(props["story"]["required"]) == {"subject", "payoff"}
    assert set(props["opening"]["required"]) == {"firstKept", "whyItOpens"}
    assert set(props["closing"]["required"]) == {
        "lastKept", "promiseKept", "whyNothingAfterIsNeeded",
    }


def test_prompts_carry_no_material_from_any_one_recording() -> None:
    """These prompts run on every project. Quoting a phrase from the clip that
    exposed a bug teaches the model that clip instead of the rule — and the next
    recording says it differently. Rules describe SHAPES (a reply particle, a
    pronoun with no referent), never words."""
    import re

    for prompt in (SPEECH_HIGHLIGHTS_SYSTEM, SPAN_TRIM_SYSTEM):
        thai = re.findall(r"[฀-๿]+", prompt)
        assert not thai, f"clip-specific Thai leaked into a prompt: {thai[:5]}"

