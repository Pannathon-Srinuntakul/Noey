"""The v1/v2 prompt switch for the ตัดฉากเด่น native-video edit call.

v2 (2026-08-15) changed how shots are chosen — spans bounded by action arcs,
spans/moments ranked instead of merely filtered, state continuity required,
and the duration quota removed. These tests pin three things: the v2 prompts
actually carry those sections, DUB_PROMPT_VERSION=v1 restores the frozen
originals byte-for-byte, and the paths that were deliberately left alone
(re-edit, Claude+frames) still say what they said before.
"""

import re

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
    # The re-edit prose keeps its own wording, minus the "≥30s apart" rule
    # (2026-09-21): distance in time never made an angle different.
    assert "≥30s apart" not in dub.DEFAULT_REEDIT_CUT_STYLE_PROSE
    assert "moments far apart in time are not different angles" in dub.DEFAULT_REEDIT_CUT_STYLE_PROSE
    assert "Demonstrating is not adjusting." in dub.DUB_REEDIT_SYSTEM_VIDEO
    assert "must also look different at a glance" in dub.DUB_REEDIT_SYSTEM_VIDEO


def test_distinct_shots_rule_is_in_the_base_video_prompts():
    # Repeated shots sit far apart in time (second takes) or come from
    # neighbouring seconds of one hold, so neither span ranking nor the ±1s
    # timeline dedupe catches them — the rule lives in the BASE prompt, where a
    # saved cut style (which replaces <editing_style> wholesale) cannot drop it.
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        assert prompt.count(dub.DISTINCT_SHOTS_BLOCK) == 1
        assert "4. COLLAPSE repeats (<distinct_shots>)" in prompt
        assert "no shot appears twice (<distinct_shots>)" in prompt
        # Setup work read as a "demo" and got cut in (2026-09-21).
        assert "Demonstrating is not adjusting." in prompt
        # A cut's END drifting into the creator walking up to the camera.
        assert "check the END as carefully as the start" in prompt
        styled = dub.apply_cut_style(prompt, "fast cuts, many angles")
        assert "<distinct_shots>" in styled
    assert "<distinct_shots>" in dub._CUT_STYLE_PRESENT_TEMPLATE


def test_both_modes_share_every_common_section_verbatim():
    def sections(system: str) -> dict[str, str]:
        return {m.group(1): m.group(2) for m in re.finditer(r"<([a-z_]+)>(.*?)</\1>", system, re.DOTALL)}

    vo, no_vo = sections(dub.DUB_EDIT_SYSTEM_VIDEO), sections(dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO)
    for tag in ("coverage", "scene_spans", "shot_quality", "distinct_shots", "alternates",
                "reject_span", "reject_safety", "reject_prep", "continuity", "music_sync",
                "anchor", "length"):
        assert vo[tag] == no_vo[tag], tag


def test_tail_restates_only_the_measured_rules_in_v2():
    clips = [("clip0", 120.0)]
    v2_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v2"
    )
    v1_text = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=clips, version="v1"
    )
    assert "Never show the same shot twice" in v2_text
    assert "no two cuts from neighbouring seconds of one hold" in v2_text
    assert "No cut may show prep" in v2_text
    # The tail is shared by both modes and read last: no voiceover wording, and
    # no editing-style guidance that would override a saved cut style.
    for leak in ("voiceover", "multi-angle", "OOTD"):
        assert leak not in v2_text
    # v1 is the rollback: its tail is the pre-2026-08-15 text, untouched.
    assert "Never show the same shot twice" not in v1_text
    assert "Default multi-angle on product/demo/OOTD lines. Follow all system rules" in v1_text


def test_default_cut_style_is_a_multi_angle_montage_of_different_moments():
    # Owner, 2026-09-21: few long single cuts were "too few shots, too long,
    # no multi-angle"; the old quota split one hold into identical neighbours.
    prose = dub.DEFAULT_CUT_STYLE_PROSE
    assert "Aim for multi-angle on most of these lines" in prose
    assert "from different moments" in prose
    assert "Never build a multi-angle line from neighbouring seconds of one hold" in prose
    assert "PEAK of its action" in prose
    assert "≥60%" not in prose
    assert "MUST split" not in prose
    # The unused Claude+frames prompt keeps its old wording.
    assert "Aim for multi-angle on ≥60% of lines" in dub.DUB_EDIT_SYSTEM


def test_a_worn_or_working_product_is_the_result_not_prep():
    # Shoe review, 2026-09-21: "fastenings are prep" dropped the whole try-on,
    # the worn result on a lifted foot included, and a line about how the
    # shoe looks worn played over a shoe held at the chest.
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO, dub.DUB_REEDIT_SYSTEM_VIDEO):
        block = re.search(r"<reject_prep>(.*?)</reject_prep>", prompt, re.DOTALL).group(1)
        assert "the fiddling is prep, the result is the demo" in block
        assert "Never drop a whole try-on or first use" in block
        assert "<reject_safety> still decides what may be shown while clothing goes on or off" in block
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        verify = re.search(r"<verify>(.*?)</verify>", prompt, re.DOTALL).group(1)
        assert "the product worn or in use" in verify
        assert "is the result, not prep" in verify
        # The last cut of a clip ran into the walk up to stop the recording.
        assert "the walk to stop the recording has begun" in verify
    script = re.search(r"<script>(.*?)</script>", dub.DUB_EDIT_SYSTEM_VIDEO, re.DOTALL).group(1)
    assert "needs a cut that shows exactly that" in script
    assert "A point that needs more than about 6s becomes two lines." in script
    tail = dub.build_dub_edit_instruction_text_video(
        target_duration_sec=None, clip_durations=[("clip0", 120.0)], version="v2"
    )
    assert "is the result, not prep" in tail


def test_live_prompts_stay_product_agnostic():
    # Clips are not only fashion. The safety block is apparel-specific on
    # purpose; every other rule must read for any product category.
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO):
        body = re.sub(r"<reject_safety>.*?</reject_safety>", "", prompt, flags=re.DOTALL)
        body = dub.apply_cut_style(body)
        for word in ("OOTD", "outfit", "cardigan", "button", "full look"):
            assert word not in body, word
    block = dub.DISTINCT_SHOTS_BLOCK
    assert "a second take of the same action" in block
    assert "two cuts from neighbouring seconds of one hold" in block
    # Narrow on purpose: different gestures/parts of one setup are a montage.
    assert "a different part of the product" in block
    assert "A quick run of such moments is a montage, not a repeat." in block
    # The unused frames path keeps its wording.
    assert "Demonstrating is not adjusting" not in dub.DUB_EDIT_SYSTEM


def test_styling_and_underwear_exceptions_stay_narrow():
    # Owner's decisions 2026-09-21: an off-shoulder drape is styling, not
    # undress; a bra review may show the bra under an open or draped layer and
    # a removable pad held up. The change itself and everything below the
    # waist stay out.
    for prompt in (dub.DUB_EDIT_SYSTEM_VIDEO, dub.DUB_EDIT_SYSTEM_VIDEO_NO_VO, dub.DUB_REEDIT_SYSTEM_VIDEO):
        block = re.search(r"<reject_safety>(.*?)</reject_safety>", prompt, re.DOTALL).group(1)
        assert "STYLING IS NOT UNDRESS" in block
        assert "never underwear that is not the product" in block
        assert "The moment of taking a layer off or putting it back on is a transition" in block
        assert "PRODUCT EXCEPTION — only when the product being reviewed is itself upper-body underwear" in block
        assert "every rule above about bottoms and the waist, still apply in full" in block
        # The original hard rejects are untouched.
        assert "ANY visible underwear (panties/briefs/boxers/bra-only)" in block
        assert "reject that frame AND every frame within ±5s" in block
