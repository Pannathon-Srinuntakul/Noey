"""Dub-first LLM cores — shared by the worker tasks and the local-render API.

Extracted verbatim from ``services/worker/tasks.py`` so the desktop app's
local-render endpoints can invoke the exact same prompts/calls without the
arq/DB coupling. Worker tasks import from here; behavior must not drift.
"""

from __future__ import annotations

import copy
import json
import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

# Cap how many beat timestamps enter the prompt — a 3-4 min track at ~120bpm has
# ~400-500 beats; the model only needs enough density to judge nearby beats, not
# the full list, and a huge list wastes context for no benefit.
_MAX_PROMPT_BEATS = 240


def format_music_block(music_beats: dict[str, Any] | None) -> str:
    """Render detect_beats() output (packages/video/beat_analysis.py) into a
    prompt data block. Empty string when no music is attached — callers append
    conditionally so prompts for music-less projects are byte-identical to before."""
    if not music_beats:
        return ""
    beats = music_beats.get("beats") or []
    if not beats:
        return ""
    tempo = music_beats.get("tempo", 0)
    beats_str = ", ".join(f"{float(b):.2f}" for b in beats[:_MAX_PROMPT_BEATS])
    return f"<music>\ntempo_bpm: {tempo}\nbeat_timestamps_sec: [{beats_str}]\n</music>"


def _line_count_hint(target_duration_sec: int) -> str:
    """Suggested line count scaled to an explicit target duration, instead of
    the fixed "12-18 lines" figure that only makes sense at the default
    ~45-60s length — a short target (e.g. a highlight cut matched to a
    trimmed music clip) needs proportionally fewer lines, or the model ends
    up squeezing every cut well below <editing_style>'s 1.5-3.5s range just
    to hit an unscaled line count (live report 2026-07-19: 19s target
    produced only ~1.9s multi-angle cuts)."""
    lo = max(3, round(target_duration_sec / 5))
    hi = max(lo + 2, round(target_duration_sec / 3.5))
    return f"{lo}-{hi}"


DUB_EDIT_SYSTEM = """<role>
You are a TikTok affiliate video editor. Produce an Edit Script JSON.
Do ALL reasoning, cataloging, and verification in English. Write voiceoverScript values in Thai.
</role>

<video_model>
This pipeline renders a SILENT video from your cuts only — the creator records voiceover AFTER watching it.
totalEstimatedSec = sum of all segment durationSec = the actual silent-video length the creator must fill with narration. There is NO separate voiceover track — durationSec IS the speaking time for that line.
</video_model>

<shot_types>
Classify every frame before using it: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below.
</shot_types>

<compare>
Passing USE is not the same as being the BEST choice. Sample frames are taken on a fixed time grid, so several frames often land within the same real-world moment or the same scene segment (same pose, same angle, same action, just a fraction of a second apart). Do not settle for the first frame that merely passes USE — look across all candidate frames near that moment/segment and pick the single strongest one, comparing: sharpest focus (not blurry/motion-smeared), best framing (subject/product fully in frame, not cut off or off-center), clearest product/logo visibility, most natural and confident expression, best lighting. If two candidate frames show essentially the same content, always prefer the objectively clearer/better-composed one over a mediocre one you happened to check first.
</compare>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments — never a trim that starts before that ready moment.
EXCEPTION — back-view product shot: a frame with the creator turned away from camera, hands at hair/head, is NOT automatically "fixing hair." If the garment's back design (neckline, straps, back pattern/logo) is clearly visible and the pose is settled (not mid-turn, not blurry), classify it as a "back-view" product shot and USE it — back design is a real selling point.
</reject_prep>

<editing_style>
Per line, set visual intent: "single-shot" (hook, calm CTA only — or any line whose footage truly offers only one usable angle; one cut, 2–4s max) or "multi-angle" (product intro, features/demo, OOTD, full-look — default here; as many cuts as the footage genuinely supports, no fixed cap — let the count follow how many genuinely distinct usable angles actually exist for that moment).
Aim for multi-angle on ≥60% of lines. Important shots (product reveal, full-look OOTD, on-body demo, hero close-up) must play COMPLETE within their cut — never cut mid-action.
Variety: each line must look VISUALLY DIFFERENT from the one before (distance, angle, or subject focus). Consecutive cuts use distinct timestamps — never the same moment twice in a row. For multi-angle, pick frames ≥30s apart when possible so the angle genuinely changes (same pose + same distance ≠ multi-angle). Do not reuse a frame consecutively or more than twice; space reuses ≥3 lines apart.
Timing: switch angles often — do not let viewers stare at one angle too long. Multi-angle is a quick flash between angles, not a series of held shots — each cut 0.5–1.5s.
Prioritize: strong product reveal, clear demonstrations, confident camera-facing delivery, clear product interaction (holding/showing/applying), genuine reactions, and a strong conclusion.
</editing_style>

<music_sync>
If a <music> block is present below, a background track will play under the final video. When a scene-change cut boundary (the start of a new segment, or a new cut within a multi-angle line) can naturally land within ~0.15s of one of the listed beat_timestamps_sec without breaking any rule above (safety, no-prep, shot completeness, variety, timing), prefer that placement. This is a soft preference, not every cut needs to hit a beat, and never force an awkward or premature cut just to chase one. If no <music> block is present, ignore this section entirely.
</music_sync>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) of the sample frame you chose.
- sourceIn must be within ±0.35s of matchedFrameTime — do NOT start the trim earlier to include prep.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
</anchor>

<script>
Understand the product, the action, and the story before writing a single line. Write a coherent Thai voiceover: hook → product intro → features/demo → full look → CTA. Each line describes ONLY what its matched frame actually shows — if no frame supports a claim, do not write that line. Do not repeat a feature already mentioned; move to the next point.
Hook: the first line (0–3s) must grab attention, not a generic stand-still intro.
Length: each line ≈ one spoken beat, 3–8s summed across its cuts. Total duration is a 45s hard floor (target 50–60s); aim for 12–18 lines (minimum 10 segments) when footage supports it.
Product lines need a frame where the label/logo is readable; vague frames → lifestyle/OOTD lines only.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing frame: creator facing camera or presenting the product toward camera.
Source: full user_script → keep wording exactly, split into scenes of 3–8s each. Brief only → write from brief + frames. Neither → infer from frames.
</script>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>

<verify>
Before returning, confirm in English: durationSec sum ≥45s (prefer ≥50s) UNLESS an explicit shorter target_duration_sec was requested, in which case durationSec sum should match THAT target instead (line/segment counts scale down with it too — do not force 12-18 lines onto a short target, that count only applies at the default ~45-60s length); ≥10 segments / 12–18 lines when no explicit target was requested; ≥60% of lines are multi-angle; last line is a CTA; no two adjacent lines look the same; zero reject_safety violations remain.
</verify>

<output_format>
Return ONLY a valid JSON object, no prose or markdown. totalEstimatedSec = sum of all durationSec.
{
  "mode": "dub_first",
  "totalEstimatedSec": 48,
  "segments": [
    {
      "order": 1, "voiceoverLineId": 1,
      "sourceClip": "clip0", "sourceIn": 5.2, "sourceOut": 8.0, "durationSec": 2.8,
      "matchedFrameTime": 5.2, "visualDescription": "ถือสินค้าใกล้กล้อง โลโก้ชัด",
      "cutStyle": "jump_cut", "voiceoverScript": "วันนี้มารีวิวตัวนี้"
    },
    {
      "order": 2, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 12.0, "sourceOut": 14.0, "durationSec": 2.0,
      "matchedFrameTime": 12.0, "visualDescription": "close-up เนื้อสินค้า",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว"
    },
    {
      "order": 3, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 47.5, "durationSec": 2.5,
      "matchedFrameTime": 45.0, "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>"""


# ── Cut style: default prose + splice machinery ─────────────────────────────
# The editing-STYLE guidance (pacing, shot choice, multi-angle taste) is no
# longer baked into the video edit prompts — it lives in a swappable
# <editing_style> block spliced via the __CUT_STYLE_BLOCK__ token, mirroring
# effects_ai.py's __STYLE_BLOCK__. With no saved style selected, the DEFAULT
# prose below (the exact sentences the prompts used to hardcode) is spliced,
# so behavior is unchanged. A saved cut style (packages/video/cut_style.py,
# EffectStyle rows with kind="cut") replaces it wholesale — invariant rules
# (<reject_safety>, <anchor>, <output_format>, an explicit user target
# duration, <coverage>) stay in the base prompts and always win.

DEFAULT_CUT_STYLE_PROSE = """Per line, set visual intent: "single-shot" (hook, calm CTA only — or any line whose footage truly offers only one usable angle; one cut, 2–4s max) or "multi-angle" (product intro, features/demo, OOTD, full-look — default here; as many cuts as the footage genuinely supports, no fixed cap — let the count follow how many genuinely distinct usable angles actually exist for that moment).
Aim for multi-angle on ≥60% of lines. Important shots (product reveal, full-look OOTD, on-body demo, hero close-up) must play COMPLETE within their cut — never cut mid-action.
Variety: each line must look VISUALLY DIFFERENT from the one before (distance, angle, or subject focus). Consecutive cuts use distinct timestamps — never the same moment twice in a row. For multi-angle, the cuts must genuinely differ in angle, distance, or subject focus (same pose + same distance ≠ multi-angle) — prefer pulling them from the same span or adjacent ones, and never reach for a far-apart timestamp merely to look different; continuity outranks variety. Do not reuse a frame consecutively or more than twice; space reuses ≥3 lines apart.
Timing: switch angles often — do not let viewers stare at one angle too long. Multi-angle is a quick flash between angles, not a series of held shots — each cut 0.5–1.5s.
Prioritize: strong product reveal, clear demonstrations, confident camera-facing delivery, clear product interaction (holding/showing/applying), genuine reactions, and a strong conclusion.
This has been observed failing in practice: lines rendered as one long single-shot hold instead of 2-3 varied cuts, even when the clip clearly shows multiple distinct angles/distances for that moment. Re-check every line against this <editing_style> section before finalizing: if the clip offers more than one usable angle for a line's topic, you MUST split it into multi-angle cuts (2-3 shorter cuts), not one continuous hold. A single cut running longer than ~4s is only acceptable when the footage genuinely offers no second usable angle for that moment."""

DEFAULT_REEDIT_CUT_STYLE_PROSE = """Per revised line, set visual intent: "single-shot" (one cut, 2–4s max) or "multi-angle" (as many cuts as the footage genuinely supports, no fixed cap; each cut 0.5–1.5s — a quick flash between angles, not a held shot). Important shots must play COMPLETE within their cut — never cut mid-action.
If the instruction asks for multi-angle, pick frames ≥30s apart when possible so the angle genuinely changes; never reuse a frame consecutively."""

_CUT_STYLE_DEFAULT_TEMPLATE = "<editing_style>\n{prose}\n</editing_style>"

_CUT_STYLE_PRESENT_TEMPLATE = """<editing_style>
The user chose a SAVED CUT STYLE for this video. The description below was
distilled from a reference video the user provided. It is the AUTHORITATIVE
guide for HOW to cut: pacing, shot length, multi-angle vs held shots, hook
treatment, pacing curve across the video, and the ending. It GOVERNS over
every generic pacing/shot-choice instinct elsewhere in this prompt. It NEVER
overrides <reject_safety>, <reject_prep>, <anchor>, <coverage>, <grouping>,
<output_format>, or the duration floor/target rules — those always win.
Never copy literal words, products, or one-off content from the reference;
apply its PATTERNS to THIS footage.
<style_description>
__CUT_STYLE_PROSE__
</style_description>
</editing_style>"""


def apply_cut_style(
    system: str,
    style_prompt: str = "",
    *,
    default_prose: str = DEFAULT_CUT_STYLE_PROSE,
) -> str:
    """Substitute __CUT_STYLE_BLOCK__ in a video edit prompt.

    Empty ``style_prompt`` → the default prose (today's behavior). Non-empty →
    the user's distilled cut style wrapped with precedence instructions.
    Fails loud if the token is missing so the literal marker can never ship
    inside a real prompt (mirrors the effects_ai regenerate guard).
    """
    if "__CUT_STYLE_BLOCK__" not in system:
        raise ValueError("system prompt lost its __CUT_STYLE_BLOCK__ token")
    prose = (style_prompt or "").strip()
    block = (
        _CUT_STYLE_PRESENT_TEMPLATE.replace("__CUT_STYLE_PROSE__", prose)
        if prose
        else _CUT_STYLE_DEFAULT_TEMPLATE.format(prose=default_prose)
    )
    return system.replace("__CUT_STYLE_BLOCK__", block)


def _prompt_version(version: str | None = None) -> str:
    """Resolve which ตัดฉากเด่น prompt generation to use ("v1" | "v2").

    An explicit ``version`` wins (tests pass it directly); otherwise the
    ``DUB_PROMPT_VERSION`` setting decides. Anything that isn't "v1" means v2 —
    a typo'd env var must degrade to the current prompts, not crash a worker.
    """
    if version:
        return version.strip().lower()
    from packages.core.settings import get_settings

    return get_settings().dub_prompt_version.strip().lower()


def select_video_edit_prompts(
    no_voiceover: bool, version: str | None = None
) -> tuple[str, str]:
    """(system, default_cut_style_prose) for the native-video edit call.

    The v2 set (default) selects by spans and ranking with no duration quota;
    ``DUB_PROMPT_VERSION=v1`` restores the exact pre-2026-08-15 prompts frozen
    in ``dub_ai_v1.py``. Callers must thread BOTH values through — the default
    prose is spliced into the system prompt by ``apply_cut_style``, so pairing
    a v1 system with the v2 prose would produce a hybrid nobody ever tested.
    """
    if _prompt_version(version) == "v1":
        from packages.video import dub_ai_v1 as v1

        return (
            v1.DUB_EDIT_SYSTEM_VIDEO_NO_VO if no_voiceover else v1.DUB_EDIT_SYSTEM_VIDEO,
            v1.DEFAULT_CUT_STYLE_PROSE,
        )
    return (
        DUB_EDIT_SYSTEM_VIDEO_NO_VO if no_voiceover else DUB_EDIT_SYSTEM_VIDEO,
        DEFAULT_CUT_STYLE_PROSE,
    )


DUB_EDIT_SYSTEM_VIDEO = """<role>
You are a TikTok affiliate video editor. Produce an Edit Script JSON.
Do ALL reasoning, cataloging, and verification in English. Write voiceoverScript values in Thai.
</role>

<method>
Work in this order. Finish each step before starting the next.

1. WATCH every clip end to end.
2. SPLIT each clip into spans (<scene_spans>).
3. DECIDE, span by span, whether to use it at all. Apply <reject_span>, then ask whether this span is strong enough to earn screen time when the rest of the footage is competing for it. Dropping most spans of a long take is the normal outcome, not a failure.
4. PICK the single best moment inside each span you kept (<shot_quality>).
5. WRITE the Thai voiceover from the moments you kept.

Step 3 is the one that decides whether the video is good. A frame that survives every rule in <reject_prep> can still sit inside a span that should never have been used — judge the span first, the frame second.
</method>

__CUT_STYLE_BLOCK__

<video_model>
This pipeline renders a SILENT video from your cuts only — the creator records voiceover AFTER watching it.
totalEstimatedSec = sum of all segment durationSec = the actual silent-video length the creator must fill with narration. There is NO separate voiceover track — durationSec IS the speaking time for that line.
</video_model>

<coverage>
Watch EVERY clip in FULL, start to finish, before selecting anything. Each clip's exact duration is given below — treat that as the range you must review, not a suggestion. The strongest material is often NOT at the start; a clip can open with setup and only reach its best product reveal, demo, or reaction near the middle or end. Never stop scanning early because you feel you already have "enough" — finish watching every clip fully, THEN decide.
Reviewing all of it is mandatory. USING all of it is not. Your job is to choose the best material, not to represent every part of the footage. A span that is merely acceptable does not earn a place in the final video just because it exists — if a stronger span already covers that beat, leave the weaker one out.
Do not cluster every choice in the first portion of a clip either: weak-because-early and weak-because-late are the same mistake. Judge on quality, wherever it sits.
</coverage>

<scene_spans>
Before choosing any timestamp, break each clip into SPANS.

A span is ONE COMPLETE ACTION BEAT: the creator moves INTO something, HOLDS it, then comes OUT of it. Bound the span by that arc — entry, hold, release — and by nothing else.

Preparation is NEVER a span of its own. Walking into frame, settling, straightening up, drawing breath, the half-second of stillness before a turn — all of it is the LEADING EDGE of the span whose payoff comes after it. Extend the span forward until the action it was leading into has completed. Then anchor inside the HOLD, never in the entry.

Same person, same outfit, same camera position does NOT make two stretches one span, and does NOT make them two spans either. The ACTION decides where a span begins and ends.

A stretch containing no completed action — the creator is present and camera-ready but nothing happens — is not a span. Do not mine it for a "usable frame".
</scene_spans>

<shot_types>
Classify each shot as you watch: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below, then rank the survivors per <shot_quality>.
</shot_types>

<shot_quality>
The reject rules below say what is UNUSABLE. They do not say what is GOOD, and frames that merely survive them are NOT equal. Rank, at both levels.

Rank SPANS against each other:
- the action completes on camera, rather than being implied or interrupted
- the product or garment is presented clearly enough to sell it
- the creator is deliberate — presenting, demonstrating, reacting — not idling between takes
- the framing holds the subject well enough to read at phone size
Prefer fewer, stronger spans over many mediocre ones.

Within a chosen span, rank MOMENTS:
- the action has ARRIVED, not begun. The pose is complete, the turn finished, the product fully presented toward camera
- the creator is engaged with the camera or with the product
- what you will claim in the description is visible AT that instant, not merely nearby
A neutral, camera-ready frame that merely looks fine ranks BELOW the deliberate action that follows it inside the same span. If the moment you are considering is followed, within its span, by the same subject in a fuller or more committed version of the same action, then what you are looking at is the run-up — move forward.
</shot_quality>

<reject_span>
Some stretches exist because the video was being MADE, not because they show anything. Drop the whole span when its purpose is production rather than content:
- the creator moves toward or away from the camera, reaches for it, or repositions it
- resetting between takes: dropping the pose, checking the phone, picking up or putting down a prop, stepping out of frame
- the framing collapses because the subject came close to the lens. A body part filling the frame with the head or shoulders cut off, moments after a full-body shot, is someone walking up to the camera — not a close-up. A real close-up holds still: the subject stays where they are and the framing is deliberate.

Drop the ENTIRE span, however good a single frame inside it looks. These frames are the ones most likely to survive the frame-level rules — the product fills the frame, nothing is being adjusted, nobody is looking away — which is exactly why the decision has to be made at span level instead.
</reject_span>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments — never a trim that starts before that ready moment.
EXCEPTION — back-view product shot: a frame with the creator turned away from camera, hands at hair/head, is NOT automatically "fixing hair." If the garment's back design (neckline, straps, back pattern/logo) is clearly visible and the pose is settled (not mid-turn, not blurry), classify it as a "back-view" product shot and USE it — back design is a real selling point.
</reject_prep>

<music_sync>
If a <music> block is present in the context above, a background track will play under the final video. When a scene-change cut boundary (the start of a new segment, or a new cut within a multi-angle line) can naturally land within ~0.15s of one of the listed beat_timestamps_sec without breaking any rule above (safety, no-prep, shot completeness, variety, timing, coverage), prefer that placement. This is a soft preference, not every cut needs to hit a beat, and never force an awkward or premature cut just to chase one. If no <music> block was given, ignore this section entirely.
</music_sync>

<continuity>
The cuts play back to back as one video. A viewer reads them as continuous unless something tells them otherwise.

State must not go backwards. Outfit, hairstyle, accessories, location, lighting, and whether an item is being worn or held all read as story progress. Once a cut has shown a later state, do not follow it with a cut from before that change — the viewer sees the outfit undo itself.

Play forward by default. Order cuts by their real source time unless a beat genuinely needs otherwise (a CTA closing on an earlier, stronger camera-facing moment is the common legitimate exception). Prefer drawing the cuts of one line from the SAME span, or from adjacent ones — cuts pulled from opposite ends of a long take rarely cut together, however different they look.

Adjacent cuts must be visually distinct, but distance in TIME is not what makes them distinct — a different angle, distance, or subject focus is. Never pick a far-apart timestamp merely to satisfy variety.
</continuity>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the video you chose for this cut.
- TIME FORMAT: decimal seconds from the start of the clip. You reason about video in MM:SS; convert before writing. A moment at 4:42 is 282.0 — writing 442.0 names a moment that does not exist. Multiply the minutes by 60, never write the digits side by side.
- sourceIn must be ≥ matchedFrameTime − 0.35s — never start the trim earlier to include prep. Starting LATER than the anchor is allowed and is often right: if the action lands a beat after the second you anchored, move sourceIn to where it actually lands.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- Multiple clips arrive as separately labeled videos (e.g. "=== clip0 ==="); sourceClip must be that exact label, and sourceIn/sourceOut are timestamps within that clip's own video.
- BEFORE any segment, emit "clipBounds": one entry per clip, copying that clip's end time from the <clips> block verbatim. Write it out first and treat those numbers as the only timestamps that exist. A value larger than a clip's end time is not a late moment in that clip — it is a moment that was never filmed.
- HARD BOUND: sourceIn and sourceOut MUST be real timestamps that exist within that clip's given duration (see <clips> below) — sourceOut can never exceed the clip's duration, and sourceIn can never be negative. Never invent or extrapolate a timestamp past the end of the actual footage.
- PRECISION: you sample the video at 1 frame/second, so a pose that only appears briefly (e.g. a quick turn to show the back) is hard to timestamp exactly — the second you pick may land a moment before or after the pose is fully visible. Prefer moments that are HELD for at least ~1 second (the creator pauses in that pose) over a fleeting transition; if a described moment (e.g. "back-view") is only visible for a fraction of a second, either find a held instance of it elsewhere in the clip or do not write a line claiming that visual — a claim in the script that isn't reliably backed by the timestamp you give will render as a mismatch.
</anchor>

<script>
This is step 5 of <method>: the spans and moments are already chosen. Write the script to fit that footage, never footage to fit a line you already wrote. Write a coherent Thai voiceover: hook → product intro → features/demo → full look → CTA. Each line describes ONLY what its matched frame actually shows — if no frame supports a claim, do not write that line. Do not repeat a feature already mentioned; move to the next point.
Hook: the first line (0–3s) must grab attention, not a generic stand-still intro.
Length: each line ≈ one spoken beat, 3–8s summed across its cuts. Calibration, not a quota: a typical TikTok affiliate review runs about 45 seconds, and most strong ones land between 45 and 60. The right length for THIS video is decided by its strong spans — a rich shoot justifies the full 60s; a thin one is better served by a tight 25–35s cut than by a padded 50s one. The number of lines follows the strong spans; never stretch it with weak spans, repeats, or invented timestamps.
QUALITY OVER DURATION: the ~45s norm above is calibration only — never a license to pad toward it. A shorter video built purely from strong spans beats a longer one padded with mediocre ones, every time. Never invent a timestamp beyond a clip's real duration, and never reuse a moment past the reuse limits in <editing_style>, just to run longer. Every segment must point at real, distinct footage that actually exists — and every segment must earn its place: if you would cut it from a client's video, cut it from this one.
Product lines need a frame where the label/logo is readable; vague frames → lifestyle/OOTD lines only.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing frame: creator facing camera or presenting the product toward camera.
Source: full user_script → keep wording exactly, split into scenes of 3–8s each. Brief only → write from brief + frames. Neither → infer from frames.
</script>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>

<verify>
Before returning, confirm in English: you watched every clip to its FULL given duration, not just the first portion; you judged each span before its frames — every cut comes from a span you decided to USE, and no cut comes from a span whose purpose was production rather than content (<reject_span>); every sourceIn/sourceOut lies within its clip's real given duration — go through the segments one by one, compare each sourceOut against that clip's end time in "clipBounds", and if even one is larger, fix it before returning rather than trusting that you stayed in range; every anchor sits inside its span's HOLD — for each cut you re-checked the remainder of that span, and no later moment shows a fuller, more committed version of the same action; no cut shows a state (outfit, hairstyle, accessories, location, product worn vs held) that an earlier cut had already moved past, and cuts play in source order except where a specific beat genuinely required otherwise; you chose on strength wherever it sits in the timeline — you did not settle for the first acceptable moment, did not stop scanning early, and did not admit a single weak span to run longer (a short total because the strong material ran out is a CORRECT result; a total past ~60s is justified only if every extra span is genuinely strong); when an explicit target_duration_sec was given, the total treats it as a ceiling — never exceeded, undershot only because strong material ran out; every line's cut pattern follows the <editing_style> section above (re-check each line against it before finalizing); the last line is a CTA matched to a closing frame; no two adjacent cuts look the same; zero reject_safety violations remain.
</verify>

<output_format>
Return ONLY a valid JSON object, no prose or markdown. totalEstimatedSec = sum of all durationSec.
{
  "mode": "dub_first",
  "totalEstimatedSec": 48,
  "segments": [
    {
      "order": 1, "voiceoverLineId": 1,
      "sourceClip": "clip0", "sourceIn": 5.2, "sourceOut": 8.0, "durationSec": 2.8,
      "matchedFrameTime": 5.2, "visualDescription": "ถือสินค้าใกล้กล้อง โลโก้ชัด",
      "cutStyle": "jump_cut", "voiceoverScript": "วันนี้มารีวิวตัวนี้"
    },
    {
      "order": 2, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 12.0, "sourceOut": 14.0, "durationSec": 2.0,
      "matchedFrameTime": 12.0, "visualDescription": "close-up เนื้อสินค้า",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว"
    },
    {
      "order": 3, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 47.5, "durationSec": 2.5,
      "matchedFrameTime": 45.0, "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>"""


DUB_EDIT_SYSTEM_VIDEO_NO_VO = """<role>
You are a TikTok editor producing an Edit Script JSON for a cut-only highlight reel — NO voiceover, NO narration script. The final video plays with only background music (if provided) plus user-added captions/stickers layered in separately afterward.
Do ALL reasoning in English.
</role>

<method>
Work in this order. Finish each step before starting the next.

1. WATCH every clip end to end.
2. SPLIT each clip into spans (<scene_spans>).
3. DECIDE, span by span, whether to use it at all. Apply <reject_span>, then ask whether this span is strong enough to earn screen time when the rest of the footage is competing for it. Dropping most spans of a long take is the normal outcome, not a failure.
4. PICK the single best moment inside each span you kept (<shot_quality>).
5. ORDER the moments you kept into the final cut. There is no script to write.

Step 3 is the one that decides whether the video is good. A frame that survives every rule in <reject_prep> can still sit inside a span that should never have been used — judge the span first, the frame second.
</method>

__CUT_STYLE_BLOCK__

<video_model>
This pipeline renders a SILENT video from your cuts only. There is no voiceover track at all — durationSec is purely how long that cut plays on screen, not "speaking time." Pace cuts per the <editing_style> section (music-driven if a <music> block is given), not for a line of dialogue.
</video_model>

<coverage>
Watch EVERY clip in FULL, start to finish, before selecting anything. Each clip's exact duration is given below — treat that as the range you must review, not a suggestion. The strongest material is often NOT at the start; a clip can open with setup and only reach its best product reveal, demo, or reaction near the middle or end. Never stop scanning early because you feel you already have "enough" — finish watching every clip fully, THEN decide.
Reviewing all of it is mandatory. USING all of it is not. Your job is to choose the best material, not to represent every part of the footage. A span that is merely acceptable does not earn a place in the final video just because it exists — if a stronger span already covers that beat, leave the weaker one out.
Do not cluster every choice in the first portion of a clip either: weak-because-early and weak-because-late are the same mistake. Judge on quality, wherever it sits.
</coverage>

<scene_spans>
Before choosing any timestamp, break each clip into SPANS.

A span is ONE COMPLETE ACTION BEAT: the creator moves INTO something, HOLDS it, then comes OUT of it. Bound the span by that arc — entry, hold, release — and by nothing else.

Preparation is NEVER a span of its own. Walking into frame, settling, straightening up, drawing breath, the half-second of stillness before a turn — all of it is the LEADING EDGE of the span whose payoff comes after it. Extend the span forward until the action it was leading into has completed. Then anchor inside the HOLD, never in the entry.

Same person, same outfit, same camera position does NOT make two stretches one span, and does NOT make them two spans either. The ACTION decides where a span begins and ends.

A stretch containing no completed action — the creator is present and camera-ready but nothing happens — is not a span. Do not mine it for a "usable frame".
</scene_spans>

<shot_types>
Classify each shot as you watch: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below, then rank the survivors per <shot_quality>.
</shot_types>

<shot_quality>
The reject rules below say what is UNUSABLE. They do not say what is GOOD, and frames that merely survive them are NOT equal. Rank, at both levels.

Rank SPANS against each other:
- the action completes on camera, rather than being implied or interrupted
- the product or garment is presented clearly enough to sell it
- the creator is deliberate — presenting, demonstrating, reacting — not idling between takes
- the framing holds the subject well enough to read at phone size
Prefer fewer, stronger spans over many mediocre ones.

Within a chosen span, rank MOMENTS:
- the action has ARRIVED, not begun. The pose is complete, the turn finished, the product fully presented toward camera
- the creator is engaged with the camera or with the product
- what you will claim in the description is visible AT that instant, not merely nearby
A neutral, camera-ready frame that merely looks fine ranks BELOW the deliberate action that follows it inside the same span. If the moment you are considering is followed, within its span, by the same subject in a fuller or more committed version of the same action, then what you are looking at is the run-up — move forward.
</shot_quality>

<reject_span>
Some stretches exist because the video was being MADE, not because they show anything. Drop the whole span when its purpose is production rather than content:
- the creator moves toward or away from the camera, reaches for it, or repositions it
- resetting between takes: dropping the pose, checking the phone, picking up or putting down a prop, stepping out of frame
- the framing collapses because the subject came close to the lens. A body part filling the frame with the head or shoulders cut off, moments after a full-body shot, is someone walking up to the camera — not a close-up. A real close-up holds still: the subject stays where they are and the framing is deliberate.

Drop the ENTIRE span, however good a single frame inside it looks. These frames are the ones most likely to survive the frame-level rules — the product fills the frame, nothing is being adjusted, nobody is looking away — which is exactly why the decision has to be made at span level instead.
</reject_span>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments — never a trim that starts before that ready moment.
EXCEPTION — back-view product shot: a frame with the creator turned away from camera, hands at hair/head, is NOT automatically "fixing hair." If the garment's back design (neckline, straps, back pattern/logo) is clearly visible and the pose is settled (not mid-turn, not blurry), classify it as a "back-view" product shot and USE it — back design is a real selling point.
</reject_prep>

<music_sync>
If a <music> block is present in the context above, a background track will play under the final video. When a scene-change cut boundary (the start of a new segment, or a new cut within a multi-angle line) can naturally land within ~0.15s of one of the listed beat_timestamps_sec without breaking any rule above (safety, no-prep, shot completeness, variety, timing, coverage), prefer that placement. This is a soft preference, not every cut needs to hit a beat, and never force an awkward or premature cut just to chase one. If no <music> block was given, ignore this section entirely.
</music_sync>

<continuity>
The cuts play back to back as one video. A viewer reads them as continuous unless something tells them otherwise.

State must not go backwards. Outfit, hairstyle, accessories, location, lighting, and whether an item is being worn or held all read as story progress. Once a cut has shown a later state, do not follow it with a cut from before that change — the viewer sees the outfit undo itself.

Play forward by default. Order cuts by their real source time unless a beat genuinely needs otherwise (a CTA closing on an earlier, stronger camera-facing moment is the common legitimate exception). Prefer drawing the cuts of one line from the SAME span, or from adjacent ones — cuts pulled from opposite ends of a long take rarely cut together, however different they look.

Adjacent cuts must be visually distinct, but distance in TIME is not what makes them distinct — a different angle, distance, or subject focus is. Never pick a far-apart timestamp merely to satisfy variety.
</continuity>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the video you chose for this cut.
- TIME FORMAT: decimal seconds from the start of the clip. You reason about video in MM:SS; convert before writing. A moment at 4:42 is 282.0 — writing 442.0 names a moment that does not exist. Multiply the minutes by 60, never write the digits side by side.
- sourceIn must be ≥ matchedFrameTime − 0.35s — never start the trim earlier to include prep. Starting LATER than the anchor is allowed and is often right: if the action lands a beat after the second you anchored, move sourceIn to where it actually lands.
- durationSec = sourceOut - sourceIn; keep the visual action inside the ready moment.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- Multiple clips arrive as separately labeled videos (e.g. "=== clip0 ==="); sourceClip must be that exact label, and sourceIn/sourceOut are timestamps within that clip's own video.
- BEFORE any segment, emit "clipBounds": one entry per clip, copying that clip's end time from the <clips> block verbatim. Write it out first and treat those numbers as the only timestamps that exist. A value larger than a clip's end time is not a late moment in that clip — it is a moment that was never filmed.
- HARD BOUND: sourceIn and sourceOut MUST be real timestamps that exist within that clip's given duration (see <clips> below) — sourceOut can never exceed the clip's duration, and sourceIn can never be negative. Never invent or extrapolate a timestamp past the end of the actual footage.
- PRECISION: you sample the video at 1 frame/second, so a pose that only appears briefly (e.g. a quick turn to show the back) is hard to timestamp exactly — the second you pick may land a moment before or after the pose is fully visible. Prefer moments that are HELD for at least ~1 second (the creator pauses in that pose) over a fleeting transition; if a described moment (e.g. "back-view") is only visible for a fraction of a second, either find a held instance of it elsewhere in the clip or do not write a line claiming that visual — a claim in the script that isn't reliably backed by the timestamp you give will render as a mismatch.
</anchor>

<visual_description>
Every segment MUST include visualDescription: a short concrete phrase (Thai or English) naming what's actually on screen — subject, action, framing (e.g. "close-up product label", "on-body demo, side angle"). This is the ONLY per-scene context the downstream effects/caption AI will have, since there is no spoken script — be specific, not vague ("nice shot").
Do NOT include a voiceoverScript field on any segment, even though the schema still lists it as available — this mode has no narration at all; leave it out entirely rather than writing filler Thai lines.
</visual_description>

<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed) — a "beat"/scene group sharing one topic/moment.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>

<verify>
Before returning, confirm in English: you watched every clip to its FULL given duration, not just the first portion; you judged each span before its frames — every cut comes from a span you decided to USE, and no cut comes from a span whose purpose was production rather than content (<reject_span>); every sourceIn/sourceOut lies within its clip's real given duration — go through the segments one by one, compare each sourceOut against that clip's end time in "clipBounds", and if even one is larger, fix it before returning rather than trusting that you stayed in range; every anchor sits inside its span's HOLD — for each cut you re-checked the remainder of that span, and no later moment shows a fuller, more committed version of the same action; no cut shows a state (outfit, hairstyle, accessories, location, product worn vs held) that an earlier cut had already moved past, and cuts play in source order except where a specific beat genuinely required otherwise; you chose on strength wherever it sits in the timeline — you did not settle for the first acceptable moment, did not stop scanning early, and did not admit a single weak span to run longer (a short total because the strong material ran out is a CORRECT result; a total past ~60s is justified only if every extra span is genuinely strong); when an explicit target_duration_sec was given, the total treats it as a ceiling — never exceeded, undershot only because strong material ran out; every line's cut pattern follows the <editing_style> section above (re-check each line against it before finalizing); the last cut is a strong closing shot (CTA framing optional — no spoken words to deliver one); no two adjacent cuts look the same; zero reject_safety violations remain.
</verify>

<output_format>
Return ONLY a valid JSON object, no prose or markdown. totalEstimatedSec = sum of all durationSec.
{
  "mode": "highlight",
  "totalEstimatedSec": 32,
  "segments": [
    {
      "order": 1, "voiceoverLineId": 1,
      "sourceClip": "clip0", "sourceIn": 5.2, "sourceOut": 8.0, "durationSec": 2.8,
      "matchedFrameTime": 5.2, "visualDescription": "ถือสินค้าใกล้กล้อง โลโก้ชัด",
      "cutStyle": "jump_cut"
    },
    {
      "order": 2, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 12.0, "sourceOut": 14.0, "durationSec": 2.0,
      "matchedFrameTime": 12.0, "visualDescription": "close-up เนื้อสินค้า",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>"""


DUB_TIMELINE_SYSTEM = """<role>
You are a TikTok video editor producing a Timeline JSON for ffmpeg rendering.
</role>

<task>
Given an Edit Script and the measured duration of the creator's recorded voiceover,
map each Edit Script segment to a position on the output timeline.
</task>

<rules>
- Total duration of all cuts MUST NOT exceed voDurationSec
- Map EVERY visual segment in the Edit Script to one timeline cut (including montage segments sharing a voiceoverLineId)
- Distribute time proportionally by durationSec; segments with the same voiceoverLineId scale together as one spoken line
- "source" must be exactly the sourceClip from the Edit Script (e.g. "clip0")
- "in" and "out" are source file timestamps — use sourceIn/sourceOut from the Edit Script
- "label": "opening" for the first cut, "conclusion" for the last cut, "speech" for all others
- Preserve every visual cut from the Edit Script — do not merge multiple angles into one long hold
- If a <music> block is given: this is the FINAL pass that fixes real output-timeline cut positions (0, cut1_duration, cut1_duration+cut2_duration, ...). After the proportional distribution above, you may nudge individual cut boundaries earlier/later by a small amount (a fraction of a second, never enough to visibly break a shot) so they land closer to a nearby beat_timestamps_sec value. Not every boundary needs a beat — use judgment, this is a soft preference. Total duration must still equal voDurationSec exactly and cut order/count must not change. Ignore this rule entirely if no <music> block is given.
</rules>

<forbidden>
Do NOT output prose, markdown, or any text outside the JSON object.
Do NOT invent new sourceIn/sourceOut values — copy them from the Edit Script.
</forbidden>

<output_format>
Return ONLY a valid JSON object matching this schema exactly:
{
  "timeline": [
    {"type": "cut", "source": "clip0", "in": 5.2, "out": 8.2, "label": "opening"},
    {"type": "cut", "source": "clip0", "in": 12.0, "out": 17.0, "label": "conclusion"}
  ]
}
</output_format>"""


def build_dub_edit_user_text(
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    frame_descs: str,
    frame_count: int,
    music_beats: dict[str, Any] | None = None,
) -> str:
    """Assemble the leading text block of the Vision edit-script request."""
    duration_hint = (
        f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Aim for roughly {_line_count_hint(target_duration_sec)} lines (scaled to this target — do NOT default to 12-18 lines, that count is only for the ~45-60s default length and would squeeze every cut far below the 1.5-3.5s range) with multi-angle middle sections so all cuts total ~{target_duration_sec}s. "
        if target_duration_sec
        else "No target set — minimum 45s, target 50–60s (standard TikTok affiliate length). totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. 45s is a hard floor — plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and keep adding until the sum reaches 45s+. "
    )
    creator_input = (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>"
    )
    music_block = format_music_block(music_beats)
    music_section = f"{music_block}\n\n" if music_block else ""
    return (
        f"{creator_input}\n\n"
        f"{music_section}"
        f"<frame_timestamps count=\"{frame_count}\">\n{frame_descs}\n</frame_timestamps>\n\n"
        "<instruction>"
        f"{duration_hint}"
        "Catalog the frames, understand the clip, then write the Thai voiceover script and match each line to the best real moments. "
        "Default multi-angle on product/demo/OOTD lines. Follow all system rules (safety, no-prep, frame-match, shot completeness, visual variety, timing, CTA). "
        "Return ONLY the Edit Script JSON."
        "</instruction>"
    )


DUB_EDIT_REMINDER = "<reminder>Return ONLY the Edit Script JSON object — no prose.</reminder>"


async def generate_dub_edit_script(
    frames: list[dict[str, Any]],
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    project_uid: str,
    music_beats: dict[str, Any] | None = None,
    system: str = DUB_EDIT_SYSTEM,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the single-step Claude Vision call: frames → normalized Edit Script dict."""
    from packages.llm.config import vision_call_kwargs
    from packages.llm.files import delete_message_files
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.scene import build_vision_content_uploaded, format_frame_descriptor
    from packages.video.timeline import normalize_dub_edit_script, parse_llm_json

    t_payload = time.monotonic()
    vision_content, vision_stats, uploaded_file_ids = await build_vision_content_uploaded(frames)
    payload_build_ms = round((time.monotonic() - t_payload) * 1000)
    frame_descs = "\n".join(format_frame_descriptor(f) for f in frames)
    user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_user_text(
        brief=brief,
        user_script=user_script,
        target_duration_sec=target_duration_sec,
        frame_descs=frame_descs,
        frame_count=len(frames),
        music_beats=music_beats,
    )}]
    user_msg_content.extend(vision_content)
    user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

    messages = [{"role": "user", "content": user_msg_content}]
    vx = vision_call_kwargs()
    text_chars = len(user_msg_content[0]["text"]) + len(user_msg_content[-1]["text"])
    log.info(
        "analyze_dub_scene_match_payload",
        project_uid=project_uid,
        model=vx.get("model", "default"),
        reasoning_effort=vx.get("reasoning_effort"),
        payload_build_ms=payload_build_ms,
        text_chars=text_chars,
        frame_count=len(frames),
        **vision_stats,
    )

    try:
        resp = await acompletion_stream_thinking(
            messages, system=system, project_uid=project_uid,
            on_thinking=on_thinking, **vx
        )
        raw = resp.choices[0].message.content or ""
        edit_script = parse_llm_json(raw)
        return normalize_dub_edit_script(edit_script, sample_frames=frames)
    finally:
        await delete_message_files(uploaded_file_ids)


DUB_EDIT_SCHEMA_VIDEO: dict[str, Any] = {
    "type": "object",
    "properties": {
        "mode": {"type": "string"},
        "totalEstimatedSec": {"type": "number"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "order": {"type": "integer"},
                    "voiceoverLineId": {"type": "integer"},
                    "sourceClip": {"type": "string"},
                    "sourceIn": {"type": "number"},
                    "sourceOut": {"type": "number"},
                    "durationSec": {"type": "number"},
                    "matchedFrameTime": {"type": "number"},
                    "visualDescription": {"type": "string"},
                    "cutStyle": {
                        "type": "string",
                        "enum": ["jump_cut", "standard", "zoom_in", "zoom_out"],
                    },
                    "voiceoverScript": {"type": "string"},
                },
                "required": [
                    "order", "voiceoverLineId", "sourceClip", "sourceIn", "sourceOut",
                    "matchedFrameTime", "cutStyle", "visualDescription",
                ],
            },
        },
    },
    "required": ["segments"],
}

def _with_clip_bounds(schema: dict[str, Any]) -> dict[str, Any]:
    """Fresh-edit variant: the model must write each clip's end time before it
    may emit a segment.

    A number it produced itself sits in its own recent output; the same number
    in the request is ~20k tokens back by the time the last segments are
    written, which is exactly where the out-of-range timestamps appear. Cheap
    (one row per clip) and mechanical — unlike the v3 span inventory it asks
    for no judgement, so it cannot displace the ranking the model does well.

    Kept off ``DUB_EDIT_SCHEMA_VIDEO`` itself because the RE-EDIT call shares
    that schema and its prompt says nothing about clipBounds; requiring a field
    a prompt never mentions is how you get a model to invent one.
    """
    out = copy.deepcopy(schema)
    out["properties"]["clipBounds"] = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {"clip": {"type": "string"}, "endsAt": {"type": "number"}},
            "required": ["clip", "endsAt"],
        },
    }
    out["required"] = ["clipBounds", "segments"]
    return out


DUB_EDIT_SCHEMA_VIDEO_BOUNDED: dict[str, Any] = _with_clip_bounds(DUB_EDIT_SCHEMA_VIDEO)

# Retry the edit call when the clamp would throw away more than this share of
# the segments. Measured on one 291.7s clip across four runs: the two bad
# renders dropped 43% and 45%, the two good ones dropped 0% — nothing landed in
# between, so the exact threshold is not delicate.
BOUNDS_RETRY_THRESHOLD = 0.2
MAX_BOUNDS_ATTEMPTS = 2


def out_of_range_segments(
    edit_script: dict[str, Any], clip_durations: dict[str, float]
) -> list[float]:
    """Timestamps the model invented past the end of their clip.

    Returned so the retry can quote them back — the prompt already states the
    bound four times, so a correction that just repeats the rule adds nothing;
    the numbers it actually produced are new information.
    """
    bad: list[float] = []
    for seg in edit_script.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        dur = clip_durations.get(str(seg.get("sourceClip") or ""))
        if dur is None:
            continue
        for key in ("sourceIn", "sourceOut"):
            try:
                value = float(seg[key])
            except (KeyError, TypeError, ValueError):
                continue
            if value > dur:
                bad.append(value)
    return sorted(set(bad), reverse=True)


def build_dub_edit_context_text_video(
    *,
    brief: str,
    user_script: str,
    clip_durations: list[tuple[str, float]],
    music_beats: dict[str, Any] | None = None,
) -> str:
    """Assemble the text block that comes BEFORE the video content.

    Per Gemini's own prompt-design guidance for long videos: data context goes
    first, specific instructions go last (after the model has "seen" the data).
    This block is just data — creator brief/script + real per-clip durations +
    optional music beat grid — no directives. See
    build_dub_edit_instruction_text_video for the directives, which are sent
    AFTER the video blocks.
    """
    creator_input = (
        f"<creator_input>\n"
        f"<brief>{brief or '(ไม่ระบุ)'}</brief>\n"
        f"<user_script>{user_script or '(ไม่ระบุ — generate จากวิดีโอ)'}</user_script>\n"
        f"</creator_input>"
    )
    # State the bound as a RANGE, not just a length. "291.7s" reads as a fact
    # about the file; "valid 0.0–291.7" reads as a constraint on the answer —
    # and the model's failure mode is inventing 442.0 for a clip it was told
    # was 291.7s long. Always interpolated from the probed duration, never a
    # literal.
    clips_block = "\n".join(
        f"{clip_id}: {dur:.1f}s — valid timestamps 0.0 to {dur:.1f}, nothing beyond {dur:.1f} exists"
        for clip_id, dur in clip_durations
    )
    music_block = format_music_block(music_beats)
    music_section = f"\n\n{music_block}" if music_block else ""
    return f"{creator_input}\n\n<clips>\n{clips_block}\n</clips>{music_section}"


def build_dub_edit_instruction_text_video(
    *,
    target_duration_sec: int | None,
    clip_durations: list[tuple[str, float]],
    version: str | None = None,
) -> str:
    """Assemble the directive block sent AFTER the video content.

    Gemini's guidance for long-video prompts: place specific instructions at
    the end, after the data — not before it, the way build_dub_edit_user_text
    (Claude+frames path) does. This is the same content that used to precede
    the video; only its position in the message moved.

    ``version`` follows DUB_PROMPT_VERSION (see select_video_edit_prompts).
    The v1 branch keeps the pre-2026-08-15 sentences verbatim — including the
    "keep adding until 45s+" quota that v2 exists to remove — so the env-var
    rollback restores the whole request, not just the system prompt.
    """
    total_footage = sum(dur for _clip_id, dur in clip_durations)
    if _prompt_version(version) == "v1":
        duration_hint = (
            f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Aim for roughly {_line_count_hint(target_duration_sec)} lines (scaled to this target — do NOT default to 12-18 lines, that count is only for the ~45-60s default length and would squeeze every cut far below the 1.5-3.5s range) with multi-angle middle sections so all cuts total ~{target_duration_sec}s, NEVER by inventing timestamps beyond a clip's real duration (see <clips> above). "
            if target_duration_sec
            else f"No target set — minimum 45s, target 50–60s (standard TikTok affiliate length), but this floor is secondary to authenticity: total available footage across all clips is {total_footage:.1f}s. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and add lines until the sum reaches 45s+ ONLY using real distinct moments — if real usable footage runs out sooner, stop there rather than inventing or reusing beyond the reuse limits. "
        )
    else:
        duration_hint = (
            f"Requested video length: ~{target_duration_sec} seconds — an AIM and a CEILING, never a quota to pad toward. Land close when the strong material supports it; never exceed it; and if the strong spans genuinely run out sooner, deliver the shorter honest cut instead. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Roughly {_line_count_hint(target_duration_sec)} lines usually fits this length (calibration, not a count to force) with multi-angle where the footage supports it — NEVER by inventing timestamps beyond a clip's real duration (see <clips> above). "
            if target_duration_sec
            else f"No target set. Calibration: a typical TikTok affiliate review runs about 45 seconds, and most strong ones land between 45 and 60 — but the right length for THIS video is decided by the footage. Total available footage across all clips is {total_footage:.1f}s; only its genuinely strong spans should appear. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Build from the strongest spans outward and stop when the next span would be filler: a tight 25–35s cut from thin footage beats a padded 50s one, and running past 45s is right exactly when every added span is strong. Never invent or reuse moments to run longer. "
        )
    # The bound restated in the last thing the model reads, per clip, in the
    # concrete form its failures take (a number bigger than the clip). Measured
    # failures on a 291.7s clip were 300.0, 320.0, 355.0, 401.5, 403.0, 408.0,
    # 409.0, 442.0 — always LATE in the segment list, never early, which is
    # what a fading memory of a bound looks like. Values are interpolated from
    # the probe; nothing here is hardcoded.
    bounds_reminder = " ".join(
        f"{clip_id} is exactly {dur:.1f}s long: its last frame is at {dur:.1f}, "
        f"so every sourceIn and sourceOut for {clip_id} must be ≤ {dur:.1f}."
        for clip_id, dur in clip_durations
    )
    return (
        "<instruction>"
        f"{duration_hint}"
        "Based on the video(s) above: watch each clip in full for its ENTIRE given duration before selecting any cuts — do not stop early once you feel you have enough. "
        "Catalog the frames, understand the clip, then write the Thai voiceover script and match each line to the best real moments from anywhere across the full timeline, including near the end. "
        "Default multi-angle on product/demo/OOTD lines. Follow all system rules (safety, no-prep, frame-match, shot completeness, visual variety, timing, CTA, coverage). "
        f"HARD LIMIT: {bounds_reminder} "
        "Start the JSON with clipBounds echoing those end times, then the segments. "
        "Return ONLY the Edit Script JSON."
        "</instruction>"
    )


async def generate_dub_edit_script_video(
    clip_videos: list[tuple[str, pathlib.Path, float]],
    *,
    brief: str,
    user_script: str,
    target_duration_sec: int | None,
    project_uid: str,
    music_beats: dict[str, Any] | None = None,
    system: str = DUB_EDIT_SYSTEM_VIDEO,
    style_prompt: str = "",
    default_cut_style_prose: str | None = None,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the Gemini native-video edit-script call: proxy clips → normalized Edit Script dict.

    ``system`` — defaults to the standard dub_first prompt; callers pass
    ``DUB_EDIT_SYSTEM_VIDEO_NO_VO`` for the no-voiceover "highlight" mode.
    Prefer resolving BOTH ``system`` and ``default_cut_style_prose`` through
    ``select_video_edit_prompts`` so DUB_PROMPT_VERSION governs the pair
    together — a v1 system with the v2 default prose is an untested hybrid.

    ``style_prompt`` — distilled cut-style prose from a saved EffectStyle row
    (kind="cut"). Empty → the hardcoded default editing style is spliced in
    (see apply_cut_style), which reproduces the pre-style behavior.

    Each clip is uploaded to the Gemini Files API and referenced by URI (not
    inline base64 — see packages/llm/files.py). sample_frames=None deliberately
    skips frame-anchoring in normalize_dub_edit_script: Gemini picks exact real
    timestamps, so there is nothing to snap to.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.timeline import (
        clamp_dub_segments_to_clip_durations,
        normalize_dub_edit_script,
        parse_llm_json,
    )

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        clip_durations = [(clip_id, duration) for clip_id, _path, duration in clip_videos]
        # Gemini's long-video guidance: data first, directives last — video
        # blocks sit between the context text and the instruction text.
        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_context_text_video(
            brief=brief,
            user_script=user_script,
            clip_durations=clip_durations,
            music_beats=music_beats,
        )}]
        for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids, strict=True):
            user_msg_content.append({"type": "text", "text": f"=== {clip_id} ==="})
            user_msg_content.append(gemini_video_block(file_id))
        user_msg_content.append({"type": "text", "text": build_dub_edit_instruction_text_video(
            target_duration_sec=target_duration_sec,
            clip_durations=clip_durations,
        )})
        user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

        messages = [{"role": "user", "content": user_msg_content}]
        extra = call_kwargs(model=model, effort=settings.dub_vision_effort)
        extra["timeout"] = settings.dub_vision_timeout_sec
        # Gemini does not reliably follow a JSON shape from prose instructions
        # alone (observed in production: it invented its own top-level keys
        # instead of "segments"). response_schema constrains decoding so the
        # shape is guaranteed, not just requested.
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": DUB_EDIT_SCHEMA_VIDEO_BOUNDED,
            "enforce_validation": True,
        }

        log.info(
            "analyze_dub_video_payload",
            project_uid=project_uid,
            model=model,
            clip_count=len(clip_videos),
            upload_ms=upload_ms,
        )

        resolved_system = apply_cut_style(
            system, style_prompt, default_prose=default_cut_style_prose or DEFAULT_CUT_STYLE_PROSE
        )
        bounds = {clip_id: duration for clip_id, _path, duration in clip_videos}

        # One retry when the model overran the footage. Nothing is re-uploaded —
        # the same file_ids are reused, so a retry costs a second inference and
        # no second upload. Both attempts are kept and the better one wins:
        # a retry that comes back worse must not replace a usable first answer.
        best: dict[str, Any] | None = None
        best_kept = -1
        for attempt in range(1, MAX_BOUNDS_ATTEMPTS + 1):
            resp = await acompletion_stream_thinking(
                messages,
                system=resolved_system,
                project_uid=project_uid,
                on_thinking=on_thinking,
                **extra,
            )
            candidate = parse_llm_json(resp.choices[0].message.content or "")
            asked = len([s for s in (candidate.get("segments") or []) if isinstance(s, dict)])
            over = out_of_range_segments(candidate, bounds)
            candidate = clamp_dub_segments_to_clip_durations(candidate, bounds)
            kept = len(candidate.get("segments") or [])
            if kept > best_kept:
                best, best_kept = candidate, kept

            drop_ratio = (asked - kept) / asked if asked else 0.0
            log.info(
                "dub_bounds_check",
                project_uid=project_uid,
                attempt=attempt,
                asked=asked,
                kept=kept,
                drop_ratio=round(drop_ratio, 2),
                out_of_range=[round(t, 1) for t in over][:12],
            )
            if drop_ratio <= BOUNDS_RETRY_THRESHOLD or attempt == MAX_BOUNDS_ATTEMPTS:
                break

            # Name the offending numbers. "Stay in range" is what the prompt
            # already said four times and it still produced these.
            messages = [
                *messages,
                {"role": "assistant", "content": resp.choices[0].message.content or ""},
                {"role": "user", "content": (
                    "<correction>Your previous answer placed "
                    f"{asked - kept} of {asked} segments outside the real footage. "
                    "These timestamps do not exist: "
                    + ", ".join(f"{t:.1f}s" for t in over[:12])
                    + ". The real bounds are: "
                    + "; ".join(f"{c} ends at {d:.1f}s" for c, d in sorted(bounds.items()))
                    + ". Redo the whole Edit Script. Keep the cuts that were already inside the "
                    "footage, and replace every out-of-range one with a real moment you can point "
                    "to in the video. Every sourceOut must be ≤ its clip's end time."
                    "</correction>"
                )},
            ]

        return normalize_dub_edit_script(best or {"segments": []}, sample_frames=None)
    finally:
        await delete_gemini_files(file_ids)


DUB_REEDIT_SYSTEM_VIDEO = """<role>
You are a TikTok affiliate video editor revising an EXISTING Edit Script at the creator's request. Do ALL reasoning in English. Write voiceoverScript values in Thai.
</role>

<video_model>
This pipeline renders a SILENT video from cuts only — the creator records voiceover AFTER watching it. durationSec IS the speaking time for that line.
</video_model>

<inputs>
You receive, in this order: the CURRENT edit script JSON (source of truth for continuity — every line/cut that already exists), an `=== edited_preview ===` video (the current silent video exactly as assembled right now, in edit-script order), one or more `=== clipN ===` raw source videos (the original unedited footage, for pulling in alternate moments), and a free-form instruction from the creator (Thai or English).
</inputs>

<scope>
The instruction message will tell you whether specific voiceoverLineIds are SELECTED or whether the scope is the WHOLE script (no selection):
- SELECTED lines: only touch those lines' content. Return ONLY the replacement segment(s) for those lines (not the rest of the script).
- WHOLE script (no selection given): the instruction may address anything. You may revise any line(s) needed to satisfy it, but you MUST return every other line byte-identical to the current edit script — never regenerate from scratch, never touch a line the instruction doesn't imply changing.
</scope>

<shot_types>
Classify any newly chosen frame/moment: hook / product-display / close-up / on-body-demo / full-body-OOTD / back-view / reaction / cta-closing. Mark USE or REJECT against the reject rules below.
</shot_types>

<compare>
When choosing a replacement moment and multiple candidates show essentially the same content, compare them for focus, framing, product/logo visibility, and expression — pick the objectively best one, not just the first that passes USE.
</compare>

<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
</reject_safety>

<reject_prep>
Skip any frame where the creator is: fixing hair, adjusting or smoothing the outfit, reaching for or touching the camera, setting up, looking off-camera/down/to the side, mid-step into a pose, or not yet ready. Use only settled, intentional, camera-ready moments.
EXCEPTION — back-view product shot: turned-away-from-camera with hands at hair/head is NOT automatically "fixing hair" if the garment's back design is clearly visible and the pose is settled — classify as back-view and USE it.
</reject_prep>

__CUT_STYLE_BLOCK__

<music_sync>
If a <music> block is present below, a background track plays under the final video. When a revised segment's cut boundary can naturally land within ~0.15s of one of the listed beat_timestamps_sec without breaking any rule above, prefer that placement. Soft preference only — never force an awkward or premature cut just to chase a beat, and never let it override what the creator's instruction actually asked for. If no <music> block is present, ignore this section.
</music_sync>

<duration>
If a <target_duration> block is present below, the creator originally asked for roughly that total video length (or it was set to match their background music). When RETIMING/SHORTENING/LENGTHENING a cut changes its durationSec, keep the overall total close to that target — a couple seconds of drift from a natural edit is fine, but don't let the total creep far off just because a longer/shorter replacement moment was available. This is a soft constraint: the creator's explicit instruction (e.g. "make this line longer") always wins over holding the target. If no <target_duration> block is present, ignore this section.
</duration>

<task>
Interpret the instruction and apply the correct operation(s) to the selected/implied line(s) — infer from the instruction alone, never ask for clarification, never expose a fixed menu of operations to the user:
- DELETE a line entirely → return an empty segments array (or omit that line's segments in whole-script mode).
- RETIME to a different moment (same clip or, if the instruction says so, elsewhere in the clip) → new sourceIn/sourceOut/matchedFrameTime, obeying reject rules.
- SHORTEN/LENGTHEN a cut's duration → adjust sourceOut and durationSec, keep the visual action complete.
- SPLIT into multi-angle → 2-3 cuts under one voiceoverLineId, each a genuinely different angle/distance.
- REWRITE voiceoverScript wording only → keep sourceIn/sourceOut/matchedFrameTime unchanged, change only the Thai text.
Combine operations freely when the instruction implies it (e.g. "shorten this and make the wording punchier" = both a duration change and a script rewrite on the same segment).
</task>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the RAW clip you chose (not the edited_preview's timeline).
- sourceIn must be within ±0.35s of matchedFrameTime.
- durationSec = sourceOut - sourceIn.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut".
- HARD BOUND: sourceIn/sourceOut must be real timestamps within that clip's given duration — never invent or extrapolate past the actual footage.
</anchor>

<grouping>
All cuts under one revised line share voiceoverLineId (reuse the ORIGINAL voiceoverLineId being revised — do not invent a new one for an existing line). voiceoverScript goes on the first cut of each line only.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>

<output_format>
Return ONLY a valid JSON object, no prose or markdown.
{
  "mode": "dub_first",
  "segments": [
    {
      "order": 1, "voiceoverLineId": 3,
      "sourceClip": "clip0", "sourceIn": 22.0, "sourceOut": 24.5, "durationSec": 2.5,
      "matchedFrameTime": 22.0, "visualDescription": "หยิบสินค้าขึ้นมาอีกมุม",
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อสัมผัสเบาสบาย"
    }
  ]
}
</output_format>"""


def build_dub_reedit_user_text(
    *,
    current_segments: list[dict[str, Any]],
    selected_line_ids: list[int],
    instruction: str,
    music_beats: dict[str, Any] | None = None,
    target_duration_sec: int | None = None,
) -> str:
    """Assemble the leading text block of the AI re-edit request."""
    scope_block = (
        f"<scope_selected_line_ids>{json.dumps(selected_line_ids)}</scope_selected_line_ids>"
        if selected_line_ids
        else "<scope_selected_line_ids>none — whole script in scope</scope_selected_line_ids>"
    )
    music_block = format_music_block(music_beats)
    current_total = sum(float(s.get("durationSec") or 0) for s in current_segments)
    duration_block = (
        f"<target_duration>Current total ~{current_total:.1f}s. "
        f"Original target ~{target_duration_sec}s.</target_duration>"
        if target_duration_sec
        else ""
    )
    return (
        f"<current_edit_script>\n{json.dumps({'segments': current_segments}, ensure_ascii=False)}\n</current_edit_script>\n\n"
        f"{scope_block}\n\n"
        + (f"{music_block}\n\n" if music_block else "")
        + (f"{duration_block}\n\n" if duration_block else "")
        + f"<creator_instruction>{instruction}</creator_instruction>"
    )


async def generate_dub_reedit_script_video(
    clip_videos: list[tuple[str, pathlib.Path, float]],
    edited_preview: tuple[pathlib.Path, float],
    *,
    current_segments: list[dict[str, Any]],
    selected_line_ids: list[int],
    instruction: str,
    project_uid: str,
    music_beats: dict[str, Any] | None = None,
    target_duration_sec: int | None = None,
    style_prompt: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    """Run the Gemini native-video AI re-edit call: current script + edited preview +
    raw clips + instruction → replacement segment(s).

    ``style_prompt`` — same distilled cut-style prose the original analyze ran
    with, so revised scenes keep the project's editing style.

    Scoped (selected_line_ids non-empty): returns ONLY the replacement segment(s)
    for those lines. Whole-script (selected_line_ids empty): returns the FULL
    replacement segments array (untouched lines echoed back unchanged by the model).
    Merge into the persisted edit script is the caller's job — see
    packages/video/timeline.py:merge_dub_reedit_segments.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.timeline import clamp_dub_segments_to_clip_durations, parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.dub_vision_model}"

    preview_path, _preview_duration = edited_preview
    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        preview_file_id = await upload_gemini_file(preview_path, mime_type="video/mp4")
        file_ids.append(preview_file_id)
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        user_msg_content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_reedit_user_text(
            current_segments=current_segments,
            selected_line_ids=selected_line_ids,
            instruction=instruction,
            music_beats=music_beats,
            target_duration_sec=target_duration_sec,
        )}]
        user_msg_content.append({"type": "text", "text": "=== edited_preview ==="})
        user_msg_content.append(gemini_video_block(preview_file_id))
        for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids[1:], strict=True):
            user_msg_content.append({"type": "text", "text": f"=== {clip_id} ==="})
            user_msg_content.append(gemini_video_block(file_id))
        user_msg_content.append({"type": "text", "text": DUB_EDIT_REMINDER})

        messages = [{"role": "user", "content": user_msg_content}]
        extra = call_kwargs(model=model, effort=settings.dub_vision_effort)
        extra["timeout"] = settings.dub_vision_timeout_sec
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": DUB_EDIT_SCHEMA_VIDEO,
            "enforce_validation": True,
        }

        log.info(
            "reedit_dub_video_payload",
            project_uid=project_uid,
            model=model,
            clip_count=len(clip_videos),
            selected_line_ids=selected_line_ids,
            upload_ms=upload_ms,
        )

        resp = await acompletion_stream_thinking(
            messages,
            system=apply_cut_style(
                DUB_REEDIT_SYSTEM_VIDEO, style_prompt,
                default_prose=DEFAULT_REEDIT_CUT_STYLE_PROSE,
            ),
            project_uid=project_uid,
            on_thinking=on_thinking, **extra
        )
        raw = resp.choices[0].message.content or ""
        result = parse_llm_json(raw)
        segments = result.get("segments") or []
        clip_durations = {clip_id: duration for clip_id, _path, duration in clip_videos}
        clamped = clamp_dub_segments_to_clip_durations({"segments": segments}, clip_durations)
        return clamped.get("segments") or []
    finally:
        await delete_gemini_files(file_ids)


def build_dub_timeline_prompt(
    edit_script: dict[str, Any],
    vo_duration: float,
    music_beats: dict[str, Any] | None = None,
) -> str:
    """Assemble the text prompt for the dub timeline planning call."""
    beats = (music_beats or {}).get("beats") or []
    # Only beats that can actually land inside the final video are relevant here.
    beats_in_range = [b for b in beats if b <= vo_duration]
    music_block = format_music_block(
        {**music_beats, "beats": beats_in_range} if beats_in_range else None
    )
    music_section = f"\n\n{music_block}" if music_block else ""
    return (
        f"<voiceover>\n"
        f"<voDurationSec>{round(vo_duration, 2)}</voDurationSec>\n"
        f"</voiceover>\n\n"
        f"<edit_script>\n{json.dumps(edit_script, ensure_ascii=False)}\n</edit_script>"
        f"{music_section}\n\n"
        f"<instruction>Map each segment to a timeline cut. "
        f"Total cut duration MUST NOT exceed {round(vo_duration, 2)} seconds.</instruction>"
    )


async def plan_dub_timeline_cuts(
    edit_script: dict[str, Any],
    vo_duration: float,
    clip_durations: list[float],
    music_beats: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Claude text call mapping Edit Script segments to render cuts.

    Returns localized, length-filtered render cuts (same post-processing the
    worker applies). Raises ValueError on empty/invalid model output.
    """
    from packages.llm.gateway import complete
    from packages.video.timeline import (
        MIN_RENDER_CUT_SEC,
        build_clip_boundaries,
        filter_short_cuts,
        localize_cuts,
        parse_llm_json,
    )

    raw = await complete(
        build_dub_timeline_prompt(edit_script, vo_duration, music_beats),
        system=DUB_TIMELINE_SYSTEM,
    )
    parsed = parse_llm_json(raw)
    raw_cuts = parsed.get("timeline", [])
    if not raw_cuts:
        raise ValueError("Claude returned empty timeline for dub_first")

    boundaries = build_clip_boundaries(clip_durations)
    render_cuts = filter_short_cuts(
        localize_cuts(raw_cuts, boundaries),
        min_sec=MIN_RENDER_CUT_SEC,
    )
    if not render_cuts:
        raise ValueError("No valid cuts remain after localization")
    return render_cuts
