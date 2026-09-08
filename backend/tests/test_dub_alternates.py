"""R18b backup shots (``alternates``) — schema, prompts, and code-side validation.

The model is called ONCE per project, same as before; the backups ride along in
that answer. Everything that keeps them honest lives in code, not in the
prompt: per-clip bounds (silent drop), >50% overlap with the main window
(silent drop), and a hard cap of 3. There is deliberately NO minimum-length
rule at plan time — the length constraint only exists in the desktop UI's
locked (post-voiceover) swap regime.
"""

from packages.video import dub_ai
from packages.video.timeline import (
    clamp_dub_segments_to_clip_durations,
    sanitize_segment_alternates,
)

CLIPS = {"clip0": 100.0, "clip1": 60.0}


def _seg(src_in=10.0, src_out=13.0, clip="clip0", order=1, alternates=None):
    seg = {
        "order": order, "voiceoverLineId": order, "sourceClip": clip,
        "sourceIn": src_in, "sourceOut": src_out, "matchedFrameTime": src_in,
        "visualDescription": "x", "cutStyle": "jump_cut",
    }
    if alternates is not None:
        seg["alternates"] = alternates
    return seg


def _alt(src_in, src_out, clip="clip0", mft=None, note="ต่างมุม"):
    return {
        "sourceClip": clip, "sourceIn": src_in, "sourceOut": src_out,
        "matchedFrameTime": src_in if mft is None else mft, "note": note,
    }


# ── prompts + schema ─────────────────────────────────────────────────────────

def test_alternates_block_present_in_all_three_fresh_edit_prompts():
    for system in (
        dub_ai.DUB_EDIT_SYSTEM,
        dub_ai.DUB_EDIT_SYSTEM_VIDEO,
        dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO,
    ):
        assert "<alternates>" in system
        assert "max 3 per segment" in system


def test_instruction_tail_restates_alternates_for_v2_only():
    """Gemini follows the directives at the message tail (the clipBounds
    lesson): with the block only in the system prompt, a live run returned
    0/12 segments with alternates. The v1 rollback request must stay free of
    it — that system prompt has no <alternates> block to obey."""
    clips = [("clip0", 100.0)]
    v2 = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v2"
    )
    v1 = dub_ai.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v1"
    )
    assert '"alternates"' in v2
    assert "alternates" not in v1


def test_reedit_prompt_keeps_untouched_alternates():
    assert "alternates" in dub_ai.DUB_REEDIT_SYSTEM_VIDEO
    assert "byte-identical" in dub_ai.DUB_REEDIT_SYSTEM_VIDEO


def test_schema_offers_alternates_capped_at_three():
    seg_props = dub_ai.DUB_EDIT_SCHEMA_VIDEO["properties"]["segments"]["items"]["properties"]
    alt = seg_props["alternates"]
    assert alt["maxItems"] == 3
    assert set(alt["items"]["required"]) == {
        "sourceClip", "sourceIn", "sourceOut", "matchedFrameTime", "note",
    }
    # The bounded (fresh-edit) variant inherits the field too.
    bounded_props = dub_ai.DUB_EDIT_SCHEMA_VIDEO_BOUNDED["properties"]["segments"]["items"][
        "properties"
    ]
    assert "alternates" in bounded_props
    # Required at DECODE time (an empty array = nothing passed): Gemini's
    # enforced decoding never fills an optional field — two live runs returned
    # 0/12. The stored contract is unchanged: sanitize_segment_alternates
    # strips empty arrays, so a segment without backups still omits the field.
    assert "alternates" in dub_ai.DUB_EDIT_SCHEMA_VIDEO["properties"]["segments"]["items"][
        "required"
    ]


# ── validation ───────────────────────────────────────────────────────────────

def test_valid_alternates_pass_through_rounded():
    seg = _seg(alternates=[_alt(30.004, 33.007, mft=31.0)])
    sanitize_segment_alternates(seg, CLIPS)
    assert seg["alternates"] == [{
        "sourceClip": "clip0", "sourceIn": 30.0, "sourceOut": 33.01,
        "matchedFrameTime": 31.0, "note": "ต่างมุม",
    }]


def test_out_of_bounds_alternate_dropped_silently():
    seg = _seg(alternates=[
        _alt(150.0, 153.0),          # starts past the clip end
        _alt(-1.0, 2.0),             # negative start
        _alt(59.0, 70.0, clip="clip1"),  # overshoot end → clamped, kept
        _alt(5.0, 8.0, clip="clip9"),    # unknown clip
    ])
    sanitize_segment_alternates(seg, CLIPS)
    assert seg["alternates"] == [{
        "sourceClip": "clip1", "sourceIn": 59.0, "sourceOut": 60.0,
        "matchedFrameTime": 59.0, "note": "ต่างมุม",
    }]


def test_overlap_with_main_window_over_half_dropped():
    # main 10–13; alt 11–14 overlaps 2s of a 3s window (67%) → drop.
    # alt 12–18 overlaps 1s of 6s (17%) → keep.
    seg = _seg(alternates=[_alt(11.0, 14.0), _alt(12.0, 18.0)])
    sanitize_segment_alternates(seg, CLIPS)
    assert [a["sourceIn"] for a in seg["alternates"]] == [12.0]


def test_overlap_rule_only_applies_on_same_clip():
    seg = _seg(alternates=[_alt(10.0, 13.0, clip="clip1")])
    sanitize_segment_alternates(seg, CLIPS)
    assert len(seg["alternates"]) == 1


def test_capped_at_three():
    seg = _seg(alternates=[_alt(20.0 + i * 5, 23.0 + i * 5) for i in range(5)])
    sanitize_segment_alternates(seg, CLIPS)
    assert len(seg["alternates"]) == 3


def test_no_minimum_length_at_plan_time():
    # 0.4s window — shorter than the main shot, still kept (locked-regime
    # length rules are a UI concern, not a plan concern).
    seg = _seg(alternates=[_alt(40.0, 40.4)])
    sanitize_segment_alternates(seg, CLIPS)
    assert len(seg["alternates"]) == 1


def test_empty_or_invalid_field_removed_entirely():
    for raw in ([], [_alt(150.0, 153.0)], "not-a-list", [{"note": "x"}]):
        seg = _seg(alternates=raw)
        sanitize_segment_alternates(seg, CLIPS)
        assert "alternates" not in seg


def test_segment_without_field_stays_without_it():
    seg = _seg()
    sanitize_segment_alternates(seg, CLIPS)
    assert "alternates" not in seg


def test_clamp_runs_alternate_sanitizer_on_kept_segments():
    script = {"segments": [
        _seg(order=1, alternates=[_alt(30.0, 33.0), _alt(150.0, 153.0)]),
        _seg(src_in=200.0, src_out=203.0, order=2, alternates=[_alt(30.0, 33.0)]),
    ]}
    out = clamp_dub_segments_to_clip_durations(script, CLIPS)
    kept = out["segments"]
    assert len(kept) == 1  # segment 2 itself is out of range
    assert [a["sourceIn"] for a in kept[0]["alternates"]] == [30.0]
