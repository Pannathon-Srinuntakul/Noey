"""The span pass has to be a step the model performs, not prose it reads.

Across six live runs the recovered thinking contains "reject", "skip",
"discard" and "rank" zero times in 7,700 characters: the model noted poses and
assigned them to script lines, never deciding whether a span was worth using.
Two structural causes, both pinned here:

  * <scene_spans> defines what a span is but asks for no decision
  * <script> was the only block written as an ordered procedure, so it became
    the procedure — the model wrote a script first and hunted frames for it

The fix adds <method> (the working order, placed second so it anchors before
any styling detail) and <reject_span> (a gate at span level; every other reject
rule in the prompt is frame-level and therefore cannot catch a good-looking
frame inside a bad span). Frame-level selection is deliberately untouched —
v3 moved the CHOICE up to span level and the cuts got worse.
"""

import re

from packages.video import dub_ai

VIDEO_SYSTEMS = (dub_ai.DUB_EDIT_SYSTEM_VIDEO, dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO)


def _sections(system: str) -> list[str]:
    spliced = dub_ai.apply_cut_style(system, "", default_prose=dub_ai.DEFAULT_CUT_STYLE_PROSE)
    return [m.group(1) for m in re.finditer(r"<([a-z_]+)>(.*?)</\1>", spliced, re.S)]


def test_method_is_the_second_block_the_model_reads():
    """Gemini's guidance puts behavioural anchors at the very top. Before this,
    the first substantial block was the styling prose, so the model framed the
    job as 'assemble cuts' rather than 'judge spans'."""
    for system in VIDEO_SYSTEMS:
        assert _sections(system)[:2] == ["role", "method"]


def test_method_states_the_order_with_the_decision_step():
    for system in VIDEO_SYSTEMS:
        method = re.search(r"<method>(.*?)</method>", system, re.S).group(1)
        assert "Finish each step before starting the next." in method
        for step in ("1. WATCH", "2. SPLIT", "3. DECIDE", "4. PICK", "5. "):
            assert step in method
        # Step 3 is the one that was missing entirely.
        assert "whether to use it at all" in method
        assert "Dropping most spans of a long take is the normal outcome" in method
        assert "judge the span first, the frame second" in method
    # The no-VO variant has no script to write.
    no_vo = re.search(r"<method>(.*?)</method>", dub_ai.DUB_EDIT_SYSTEM_VIDEO_NO_VO, re.S).group(1)
    assert "There is no script to write." in no_vo
    assert "Thai voiceover" not in no_vo


def test_reject_span_gates_at_span_level_ahead_of_the_frame_rules():
    for system in VIDEO_SYSTEMS:
        order = _sections(system)
        assert order.index("reject_span") < order.index("reject_safety")
        assert order.index("reject_span") < order.index("reject_prep")
        block = re.search(r"<reject_span>(.*?)</reject_span>", system, re.S).group(1)
        # The exact failure it exists to catch: the creator walking up to the
        # camera reads as a close-up because the product fills the frame.
        assert "moves toward or away from the camera" in block
        assert "is someone walking up to the camera — not a close-up" in block
        assert "Drop the ENTIRE span, however good a single frame inside it looks." in block
        # And why a frame-level rule cannot catch it.
        assert "most likely to survive the frame-level rules" in block


def test_script_no_longer_competes_to_be_the_main_procedure():
    script = re.search(r"<script>(.*?)</script>", dub_ai.DUB_EDIT_SYSTEM_VIDEO, re.S).group(1)
    assert script.strip().startswith("This is step 5 of <method>")
    assert "never footage to fit a line you already wrote" in script
    # The narrative shape itself is unchanged.
    assert "hook → product intro → features/demo → full look → CTA" in script


def test_verify_checks_the_span_decision():
    for system in VIDEO_SYSTEMS:
        verify = re.search(r"<verify>(.*?)</verify>", system, re.S).group(1)
        assert "you judged each span before its frames" in verify
        assert "no cut comes from a span whose purpose was production rather than content" in verify


def test_frame_level_selection_is_untouched():
    """v3's mistake was moving the CHOICE up to span level; only the REJECT
    moves here."""
    for system in VIDEO_SYSTEMS:
        quality = re.search(r"<shot_quality>(.*?)</shot_quality>", system, re.S).group(1)
        assert "Within a chosen span, rank MOMENTS" in quality
        assert "the action has ARRIVED, not begun" in quality
        # No forced inventory output, unlike v3.
        assert "spanInventory" not in system
        assert "spanId" not in system


def test_other_prompt_paths_are_not_affected():
    for other in (dub_ai.DUB_EDIT_SYSTEM, dub_ai.DUB_REEDIT_SYSTEM_VIDEO, dub_ai.DUB_TIMELINE_SYSTEM):
        assert "<method>" not in other
        assert "<reject_span>" not in other
