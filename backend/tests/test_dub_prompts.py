"""The v1/v2 prompt switch for the ตัดฉากเด่น native-video edit call.

v2 (2026-08-15) changed how shots are chosen — spans bounded by action arcs,
spans/moments ranked instead of merely filtered, state continuity required,
and the duration quota removed. These tests pin three things: the v2 prompts
actually carry those sections, DUB_PROMPT_VERSION=v1 restores the frozen
originals byte-for-byte, and the paths that were deliberately left alone
(re-edit, Claude+frames) still say what they said before.
"""

from packages.video import dub_ai as dub
from packages.video import dub_ai_v1 as v1


def test_v2_prompts_carry_the_new_sections_and_no_quota():
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        for marker in (
            "<scene_spans>",
            "<shot_quality>",
            "<continuity>",
            "__CUT_STYLE_BLOCK__",
            "<reject_safety>",
        ):
            assert marker in prompt
        # The quota language v2 exists to remove.
        assert "hard floor" not in prompt
        assert "12–18 lines" not in prompt
        assert "≥10 segments" not in prompt
        # The spread-the-cuts pressure that fought continuity.
        assert "spread across each clip" not in prompt
    # The calibration anchor the owner chose (45s) survives as context.
    assert "about 45 seconds" in dub.DUB_EDIT_SYSTEM_VIDEO


def test_v1_selection_returns_the_frozen_prompts():
    system_vo, prose = dub.select_video_edit_prompts(False, version="v1")
    assert system_vo == v1.DUB_EDIT_SYSTEM_VIDEO
    assert prose == v1.DEFAULT_CUT_STYLE_PROSE
    system_no_vo, _ = dub.select_video_edit_prompts(True, version="v1")
    assert system_no_vo == v1.DUB_EDIT_SYSTEM_VIDEO_NO_VO
    # The frozen file really is the old behaviour, not a copy of the new one.
    assert "45s hard floor" in v1.DUB_EDIT_SYSTEM_VIDEO
    assert "≥30s apart" in v1.DEFAULT_CUT_STYLE_PROSE


def test_v2_selection_returns_the_live_prompts():
    system_vo, prose = dub.select_video_edit_prompts(False, version="v2")
    assert system_vo == dub.DUB_EDIT_SYSTEM_VIDEO
    assert prose == dub.DEFAULT_CUT_STYLE_PROSE
    # An unknown value degrades to v2 rather than crashing a worker.
    system_typo, _ = dub.select_video_edit_prompts(False, version="v3-oops")
    assert system_typo == dub.DUB_EDIT_SYSTEM_VIDEO


def test_instruction_text_no_target_by_version():
    clips = [("clip0", 291.7)]
    v2_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v2"
    )
    assert "Calibration" in v2_text
    assert "291.7s" in v2_text
    assert "keep adding" not in v2_text
    assert "minimum 45s" not in v2_text

    v1_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v1"
    )
    assert "minimum 45s" in v1_text
    assert "keep adding" not in v1_text  # the video path never had that exact line
    assert "add lines until the sum reaches 45s+" in v1_text


def test_instruction_text_explicit_target_is_a_ceiling_in_v2():
    clips = [("clip0", 120.0)]
    v2_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=30, clip_durations=clips, version="v2"
    )
    assert "CEILING" in v2_text
    assert "never exceed it" in v2_text
    assert "deliver the shorter honest cut" in v2_text

    v1_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=30, clip_durations=clips, version="v1"
    )
    assert "so all cuts total ~30s" in v1_text


def test_apply_cut_style_splices_both_default_proses():
    for version in ("v1", "v2"):
        system, prose = dub.select_video_edit_prompts(False, version=version)
        spliced = dub.apply_cut_style(system, "", default_prose=prose)
        assert "__CUT_STYLE_BLOCK__" not in spliced
        assert prose.split("\n")[0][:60] in spliced


def test_untouched_paths_still_say_what_they_said():
    # Q4 decision: the Claude+frames path keeps its old duration rules.
    frames_text = dub.build_dub_edit_user_text(
        brief="", user_script="", target_duration_sec=None, frame_descs="", frame_count=0
    )
    assert "45s is a hard floor" in frames_text
    # The re-edit prose was deliberately left with its own wording.
    assert "≥30s apart" in dub.DEFAULT_REEDIT_CUT_STYLE_PROSE
