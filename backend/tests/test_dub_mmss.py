"""MM:SS digits leaking into decimal-second timestamps.

Gemini's video docs say to reference moments as MM:SS, and that is how the
model reasons about a clip — but the Edit Script schema asks for decimal
seconds, so a shot at 4:42 can arrive as the number 442.0. On a 291.7s clip
that reads as "beyond the end of the footage" and the clamp threw it away:
two live runs lost 6 and 5 segments this way and rendered as 17-second
fragments.

Decoding the 11 rejected values from those runs turns every one into an
ordinary 1.5-3.5s cut inside the clip, so the repair runs before the clamp.
It is deliberately conservative — see repair_mmss_timestamps.
"""

import pytest

from packages.video import dub_ai
from packages.video.timeline import (
    DUB_MMSS_MAX_CUT_SEC,
    clamp_dub_segments_to_clip_durations,
    repair_mmss_timestamps,
)

CARGO = 291.7

# Every pair the clamp rejected across the two failing production runs.
LIVE_REJECTS = [
    ((409.0, 410.5), (249.0, 250.5)),
    ((335.5, 337.5), (215.5, 217.5)),
    ((356.0, 358.5), (236.0, 238.5)),
    ((300.0, 302.5), (180.0, 182.5)),
    ((403.0, 405.0), (243.0, 245.0)),
    ((442.0, 445.5), (282.0, 285.5)),
    ((320.0, 323.0), (200.0, 203.0)),
    ((355.0, 358.5), (235.0, 238.5)),
    ((408.0, 410.5), (248.0, 250.5)),
    ((442.0, 445.0), (282.0, 285.0)),
    ((401.5, 404.5), (241.5, 244.5)),
]


def _seg(src_in, src_out, clip="clip0", order=1, mft=None):
    return {
        "order": order, "voiceoverLineId": order, "sourceClip": clip,
        "sourceIn": src_in, "sourceOut": src_out,
        "matchedFrameTime": src_in if mft is None else mft,
        "visualDescription": "x", "cutStyle": "jump_cut",
    }


def test_every_live_reject_decodes_to_a_real_moment():
    script = {"segments": [_seg(a, b, order=i + 1) for i, ((a, b), _) in enumerate(LIVE_REJECTS)]}
    assert repair_mmss_timestamps(script, {"clip0": CARGO}) == len(LIVE_REJECTS)
    for seg, (_, (want_in, want_out)) in zip(script["segments"], LIVE_REJECTS):
        assert seg["sourceIn"] == pytest.approx(want_in)
        assert seg["sourceOut"] == pytest.approx(want_out)
        assert seg["matchedFrameTime"] == pytest.approx(want_in)
        assert seg["durationSec"] == pytest.approx(round(want_out - want_in, 2))


def test_repaired_segments_survive_the_clamp_instead_of_being_dropped():
    """The whole point: these used to render as a 17-second fragment."""
    script = {"segments": [_seg(a, b, order=i + 1) for i, ((a, b), _) in enumerate(LIVE_REJECTS)]}
    out = clamp_dub_segments_to_clip_durations(script, {"clip0": CARGO})
    assert len(out["segments"]) == len(LIVE_REJECTS)
    assert all(s["sourceOut"] <= CARGO for s in out["segments"])


def test_in_range_timestamps_are_never_reinterpreted():
    """128.5 could be 1:28.5, but it is also a perfectly good 128.5s and there
    is no way to tell — guessing here would corrupt good cuts."""
    script = {"segments": [_seg(128.5, 131.0), _seg(52.0, 54.5, order=2)]}
    assert repair_mmss_timestamps(script, {"clip0": CARGO}) == 0
    assert script["segments"][0]["sourceIn"] == 128.5
    assert script["segments"][1]["sourceOut"] == 54.5


def test_half_out_of_range_is_left_to_the_clamp():
    """sourceIn inside the clip means this is an overshoot, not a format slip —
    repairing it would move a cut the model placed correctly."""
    script = {"segments": [_seg(285.0, 305.0)]}
    assert repair_mmss_timestamps(script, {"clip0": CARGO}) == 0
    out = clamp_dub_segments_to_clip_durations(script, {"clip0": CARGO})
    assert out["segments"][0]["sourceOut"] == pytest.approx(CARGO)


@pytest.mark.parametrize(
    "pair,why",
    [
        ((380.0, 390.0), "seconds field 80/90 is not a real clock reading"),
        ((999.0, 1001.0), "decodes past the end of the clip"),
        ((95.0, 97.0), "minutes field 0 — not MM:SS digits"),
        ((300.0, 425.0), "decoded cut would run far longer than any real cut"),
    ],
)
def test_implausible_values_are_not_repaired(pair, why):
    script = {"segments": [_seg(*pair)]}
    assert repair_mmss_timestamps(script, {"clip0": 90.0 if pair[0] == 95.0 else CARGO}) == 0, why


def test_max_cut_guard_is_the_boundary():
    dur = DUB_MMSS_MAX_CUT_SEC
    # 3:00.0 -> 180.0 and 3:00.0+dur -> 180+dur : exactly at the limit, allowed.
    script = {"segments": [_seg(300.0, 300.0 + dur)]}
    assert repair_mmss_timestamps(script, {"clip0": CARGO}) == 1
    # One tenth over the limit is refused.
    script = {"segments": [_seg(300.0, 300.0 + dur + 0.1)]}
    assert repair_mmss_timestamps(script, {"clip0": CARGO}) == 0


def test_multi_clip_uses_each_clips_own_duration():
    script = {
        "segments": [
            _seg(442.0, 445.0, clip="clip0", order=1),  # 282.0 fits the long clip
            _seg(442.0, 445.0, clip="clip1", order=2),  # 282.0 is past the short one
        ]
    }
    assert repair_mmss_timestamps(script, {"clip0": CARGO, "clip1": 60.0}) == 1
    assert script["segments"][0]["sourceIn"] == pytest.approx(282.0)
    assert script["segments"][1]["sourceIn"] == 442.0  # untouched, clamp drops it


def test_prompt_states_the_format_on_the_video_paths_only():
    for system in (dub_ai.DUB_EDIT_SYSTEM_VIDEO, dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        assert "TIME FORMAT" in system
        assert "A moment at 4:42 is 282.0" in system
        assert "never write the digits side by side" in system
    # The Claude+frames path anchors to sampled frames and has never shown this
    # failure; the re-edit path copies timestamps from an existing script.
    assert "TIME FORMAT" not in dub_ai.DUB_EDIT_SYSTEM
    assert "TIME FORMAT" not in dub_ai.DUB_REEDIT_SYSTEM_VIDEO
