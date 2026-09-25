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

# R18b: per-segment backup shots, returned inside the SAME analysis call — no
# extra model calls, ever. Shared verbatim by the fresh-edit prompts (Claude
# frames + both Gemini video variants); the reedit prompt carries its own
# shorter variant (see DUB_REEDIT_SYSTEM_VIDEO).
ALTERNATES_BLOCK = """<alternates>
For each segment, AFTER picking its winning moment, also return the runners-up as "alternates" (max 3 per segment). Two sources qualify:
(a) frames/moments at the SAME beat that lost the comparison above but still pass EVERY rule (safety, no-prep, shot completeness);
(b) a moment ELSEWHERE in the footage that fits that line's content, passes every rule, and is not used by any other segment.
Every alternate MUST carry: sourceClip, sourceIn, sourceOut, matchedFrameTime (same bounds rules as the main segment — real timestamps only), and a one-line Thai "note" saying how it differs from the chosen shot (e.g. "ชิดกว่า เห็นเลข SPF ใหญ่ แต่ขอบขวดหลุดเฟรมบน") — the user decides from the note without opening each one.
An alternate does NOT need to match the main segment's duration — give its natural window.
All reject rules (<reject_safety>, <reject_prep>) apply to alternates IN FULL — an alternate that breaks a safety rule is a safety bug.
If no candidate passes every rule, return an empty alternates array for that segment. NEVER pad to three or lower the bar — quantity is not the goal.
</alternates>"""

# Repeated shots. Observed live (2026-09-21): multi-angle lines built from
# neighbouring seconds of one hold (cuts 0.4s apart that look identical) and
# second takes of the same demo cut in minutes apart — neither span ranking nor
# the ±1s DUB_SOURCE_DEDUPE_SEC guard in timeline.py can see those. Lives in
# the BASE video prompts (not the swappable <editing_style>) so a saved cut
# style cannot drop it. Deliberately narrow: an earlier "one cut per look"
# version (same framing = same shot) left 5-9 cuts on a 3-minute clip, and the
# owner wants a fast multi-angle montage — different gestures, parts, and
# moments of one setup are different shots.
DISTINCT_SHOTS_BLOCK = """<distinct_shots>
The viewer never sees the same shot twice. The same shot means one of three things:
- the same moment used again;
- a second take of the same action — the same demo, pose, or line filmed again later. Keep only the best take on screen; the others go in that segment's "alternates";
- two cuts from neighbouring seconds of one hold. A jump inside one hold is not a new angle.
Different moments of one setup ARE different shots when something visible changes: a different gesture or action, a different part of the product, a different distance or angle, or a changed state (opened, applied, worn, switched on, taken apart, turned around). A quick run of such moments is a montage, not a repeat.
Adjacent cuts must look clearly different at a glance.
</distinct_shots>"""


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


def music_beats_on_output(
    music_beats: dict[str, Any] | None,
    *,
    offset_sec: float = 0.0,
    trim_in_sec: float = 0.0,
    trim_out_sec: float | None = None,
) -> dict[str, Any] | None:
    """Move detect_beats() output from music-FILE time to OUTPUT-timeline time.

    detect_beats runs on the whole uploaded file, but the prompts read
    beat_timestamps_sec as positions in the finished video. Once the user
    trims the song's intro or slides the track, file time and output time
    disagree and cuts snap to where a beat would be in the untrimmed file.
    A file beat b plays at b - trim_in + offset; beats before trim_in or at or
    after trim_out are never heard and are dropped.

    With the defaults (untrimmed track at 0) the input comes back unchanged, so
    clients that never send a window get byte-identical prompts.
    """
    if not music_beats:
        return music_beats
    if offset_sec == 0 and trim_in_sec == 0 and trim_out_sec is None:
        return music_beats
    mapped = [
        round(float(b) - trim_in_sec + offset_sec, 3)
        for b in music_beats.get("beats") or []
        if float(b) >= trim_in_sec and (trim_out_sec is None or float(b) < trim_out_sec)
    ]
    return {**music_beats, "beats": mapped}


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

""" + ALTERNATES_BLOCK + """

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
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว",
      "alternates": [
        { "sourceClip": "clip0", "sourceIn": 31.0, "sourceOut": 34.1, "matchedFrameTime": 31.2,
          "note": "ชิดกว่า เห็นเนื้อครีมชัด แต่แสงมืดกว่า" }
      ]
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
# The editing-STYLE guidance (pacing, shot choice, multi-angle taste) is not
# baked into the video edit prompts — it lives in a swappable <editing_style>
# block spliced via the __CUT_STYLE_BLOCK__ token, mirroring effects_ai.py's
# __STYLE_BLOCK__. With no saved style selected, the DEFAULT prose below is
# spliced. A saved cut style (packages/video/cut_style.py, EffectStyle rows with
# kind="cut") replaces it wholesale — invariant rules (<reject_safety>,
# <distinct_shots>, <anchor>, <output_format>, an explicit user target
# duration, <coverage>) stay in the base prompts and always win.
#
# 2026-09-21: multi-angle stays the default, but its cuts must come from
# DIFFERENT moments. The old wording ("≥60% multi-angle", "MUST split",
# "prefer the same span") made the model split one static hold into
# neighbouring seconds that look identical; removing multi-angle altogether
# instead produced a few long, slow cuts — the owner rejected both.
# Same day, on a 5.5-minute shoe review: "2–3 quick cuts" per line held while
# the lines grew to 8–10s, so every cut stretched to ~3s (2.9s average against
# 1.9s before). The limit is now on cut length, not on cut count.

DEFAULT_CUT_STYLE_PROSE = """Per line, set visual intent:
- "multi-angle" — the default for product intro, features/demo, and result lines: quick cuts of about 0.8–2s each, as many as the line's length needs, that show the line's point from different moments — a different gesture, a different part of the product, a different distance or angle, or a changed state (<distinct_shots>). Aim for multi-angle on most of these lines.
- "single-shot" — the hook and a calm CTA: one cut of 1.5–3s.
Pace: switch shots often — the viewer should never stare at one shot. Outside the hook and the CTA, no cut runs past about 2s: when a line needs more time, give it another moment, not a longer cut. Each quick cut shows the PEAK of its action, the moment it has arrived, never the start of it.
Never build a multi-angle line from neighbouring seconds of one hold — that is one shot with a jump in it, not two angles. Each line must look VISUALLY DIFFERENT from the line before it.
Important shots — the product reveal, a demo's result, a full view, a hero close-up — play COMPLETE within their cut; never cut mid-action.
Prioritize: a strong product reveal, clear demonstrations, confident camera-facing delivery, clear product interaction (holding, showing, using), genuine reactions, and a strong conclusion."""

DEFAULT_REEDIT_CUT_STYLE_PROSE = """Per revised line, set visual intent: "single-shot" (one cut, 2–4s max) or "multi-angle" (as many cuts as the footage genuinely supports, no fixed cap; each cut 0.5–1.5s — a quick flash between angles, not a held shot). Important shots must play COMPLETE within their cut — never cut mid-action.
If the instruction asks for multi-angle, each cut must show a genuinely different look — a different distance, angle, or subject focus; moments far apart in time are not different angles by themselves. Never reuse a moment."""

_CUT_STYLE_DEFAULT_TEMPLATE = "<editing_style>\n{prose}\n</editing_style>"

_CUT_STYLE_PRESENT_TEMPLATE = """<editing_style>
The user chose a SAVED CUT STYLE for this video. The description below was
distilled from a reference video the user provided. It is the AUTHORITATIVE
guide for HOW to cut: pacing, shot length, multi-angle vs held shots, hook
treatment, pacing curve across the video, and the ending. It GOVERNS over
every generic pacing/shot-choice instinct elsewhere in this prompt. It NEVER
overrides <reject_safety>, <reject_prep>, <distinct_shots>, <anchor>, <coverage>, <grouping>,
<output_format>, or an explicit target duration — those always win.
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


# ── Native-video edit prompts (the live set) ────────────────────────────────
# Both modes are assembled from the shared sections below, so a rule changes in
# one place and the two modes cannot drift apart. Only role, method step 6,
# video model, script/visual description, grouping, verify and output differ.
# Every sentence here is either a rule the model needs or a measured failure
# pinned by a test — before adding one, check whether a section already says
# it; restating a rule in three places made the model weigh each copy less.

_VIDEO_COVERAGE = """<coverage>
Watch EVERY clip in FULL, start to finish, before selecting anything. Each clip's exact duration is given below — treat that as the range you must review, not a suggestion. The strongest material is often NOT at the start; a clip can open with setup and only reach its best reveal, demo, or reaction near the middle or end.
Reviewing all of it is mandatory. USING all of it is not. Choose the best material; do not try to represent every part of the footage. A span that is merely acceptable does not earn a place just because it exists — if a stronger span already covers that beat, leave the weaker one out.
Judge on quality wherever it sits: picks crowded into the first part of a clip usually mean the later material was never weighed against them.
Reject spans, never whole stretches of time: when a few spans in a region break a rule, the spans between them are still judged on their own.
</coverage>"""

_VIDEO_SCENE_SPANS = """<scene_spans>
Before choosing any timestamp, break each clip into SPANS.

A span is ONE COMPLETE ACTION BEAT: the creator moves INTO something, HOLDS it, then comes OUT of it. Bound the span by that arc — entry, hold, release — and by nothing else.

Preparation is NEVER a span of its own. Walking into frame, settling, straightening up, drawing breath, the half-second of stillness before a turn — all of it is the LEADING EDGE of the span whose payoff comes after it. Extend the span forward until the action it was leading into has completed. Then anchor inside the HOLD, never in the entry.

The same person, setup, and camera position does NOT make two stretches one span, and does NOT make them two spans either. The ACTION decides where a span begins and ends.

A stretch containing no completed action — the creator is present and camera-ready but nothing happens — is not a span. Do not mine it for a "usable frame".
</scene_spans>"""

_VIDEO_SHOT_QUALITY = """<shot_quality>
Classify each shot as you watch: hook / product-display / close-up / demo / result / full-view / reaction / cta-closing. Mark each USE or REJECT against the reject rules below, then rank the survivors.

The reject rules say what is UNUSABLE. They do not say what is GOOD, and frames that merely survive them are NOT equal. Rank, at both levels.

Rank SPANS against each other:
- the action completes on camera, rather than being implied or interrupted
- the product is presented clearly enough to sell it
- the creator is deliberate — presenting, demonstrating, reacting — not idling between takes
- the framing holds the subject well enough to read at phone size
Prefer fewer, stronger spans over many mediocre ones.

Within a chosen span, rank MOMENTS:
- the action has ARRIVED, not begun. The pose is complete, the turn finished, the product fully presented toward camera
- the creator is engaged with the camera or with the product
- what you will claim in the description is visible AT that instant, not merely nearby
A neutral, camera-ready frame that merely looks fine ranks BELOW the deliberate action that follows it inside the same span. If the moment you are considering is followed, within its span, by the same subject in a fuller or more committed version of the same action, then what you are looking at is the run-up — move forward.
</shot_quality>"""

# Movement (2026-09-21, shoe review): "moves toward or away from the camera"
# was read as production and dropped the try-on (stepping back to show the shoe
# worn) and the swing toward the lens — the two shots the owner missed most.
# Only the walk to and from the camera is production.
_VIDEO_REJECT_SPAN = """<reject_span>
Some stretches exist because the video was being MADE, not because they show anything. Drop the whole span when its purpose is production rather than content:
- the creator walks up to the camera to reach it, stop it, or reposition it, or walks back into place afterwards. The last seconds of a clip usually end this way — the creator walking up to stop the recording — so check any cut near a clip's end
- resetting between takes: dropping the pose, checking the phone, picking up or putting down a prop, stepping out of frame
- the framing collapses because the subject came close to the lens. A body part filling the frame with the head or shoulders cut off, moments after a full-body shot, is someone walking up to the camera — not a close-up. A real close-up is deliberate: the subject holds still, or pushes the product toward the lens to show it.

Movement alone is not production. Stepping back so the product can be seen worn or in full, turning to show it, or swinging it toward the lens is a presentation — content. Judge a movement by what the viewer sees during it: the product being shown is content; only handling the camera, or walking to and from it, is production.

Drop the ENTIRE span, however good a single frame inside it looks. These frames are the ones most likely to survive the frame-level rules — the product fills the frame, nothing is being adjusted, nobody is looking away — which is exactly why the decision has to be made at span level instead.
</reject_span>"""

# STYLING + PRODUCT EXCEPTION (2026-09-21, owner's decisions): the block was
# written for apparel try-ons, so the model read an off-shoulder drape (a
# styling choice) as "partial undress" and, on a bra review, the product itself
# as "visible underwear" — dropping the pad demo and ~74s of styled footage.
# The mid-change moment stays out (as a transition), and nothing below the
# waist is relaxed.
_VIDEO_REJECT_SAFETY = """<reject_safety>
HARD REJECT — never use a frame or trim that shows or leads into: putting on OR taking off pants/skirts/shorts/trousers; holding bottoms open at the waist (fly open, waistband spread, stepping in); pulling clothing up/down before fully worn; ANY visible underwear (panties/briefs/boxers/bra-only); partial undress or wardrobe change.
Even if the still looks fine — if the creator is mid dress/undress the trim WILL expose underwear. Skip it.
EXTRA: light-colored bottoms (white/cream/beige/light pink) with hands near the waistband, or a loose/open/unzipped waistband → reject that frame AND every frame within ±5s. Do not gamble.
Outfit must be fully ON and fastened. "เตรียมชุด" voiceover → finished look only.
STYLING IS NOT UNDRESS — a layer (jacket, cardigan, shirt) deliberately worn open, or draped off one or both shoulders and held as a pose, is part of the look and counts as fully on — provided what shows underneath is ordinary clothing or the product itself, never underwear that is not the product. The moment of taking a layer off or putting it back on is a transition: use the settled look, not the change.
PRODUCT EXCEPTION — only when the product being reviewed is itself upper-body underwear or a swimwear top (a bra, bralette, bikini top): that product worn under an open or draped layer is the product being shown, not "visible underwear", and a removable part of it (a pad, an insert) taken out and held up to the camera is a product demo. Neither clause relaxes anything else: changing, and every rule above about bottoms and the waist, still apply in full.
</reject_safety>"""

# Try-on (same shoe review): "doing up fastenings is prep" dropped the whole
# putting-on stretch, the worn result on a lifted foot included.
_VIDEO_REJECT_PREP = """<reject_prep>
Skip any moment where the creator is fixing hair, reaching for or touching the camera, setting up, looking away from both the camera and the product, stepping into a pose, or not yet ready. Use only settled, intentional moments — never a trim that starts before the ready moment.
Demonstrating is not adjusting. Stretching, pressing, opening, applying, or pointing at the product to SHOW a feature to the camera is a demo — use it. Adjusting is incidental fixing that shows the viewer nothing: putting things back in place, doing up or undoing fastenings, arranging the setup. That is prep — use the settled result once the hands have left it, even when the script talks about that step. If the hands are still working a fastening, it is not finished yet.
Putting the product on or into use works the same way: the fiddling is prep, the result is the demo. The moment it is ON or WORKING and shown to the camera — worn and displayed (a shoe on a lifted foot, a garment turned toward the camera), applied, switched on — is often the strongest shot in the footage. Use it even when a hand still rests on the product; only hands still working it are prep. Never drop a whole try-on or first use — drop only its start. <reject_safety> still decides what may be shown while clothing goes on or off.
A shot turned away from the camera is not automatically prep: when it deliberately shows a side of the product that sells it (the back of a garment, the rear of a device) and the pose is settled, not mid-turn, use it.
</reject_prep>"""

_VIDEO_CONTINUITY = """<continuity>
The cuts play back to back as one video. A viewer reads them as continuous unless something tells them otherwise.

Never cut backwards. Play the material in the order it was given: clips in the order they were supplied, and inside each clip forward in time. The one common exception: the CTA may close on an earlier, stronger camera-facing moment. What changes BETWEEN clips — setting, lighting, look, day — is not a continuity error and is never a reason to avoid a clip; the user chose to shoot it that way. Cut across every clip that has strong material.

The cuts of one multi-angle line show the line's point from different moments that share the same setup and state, in forward order; never mix in a moment from before a visible change (a layer taken off, a product opened or applied) that an earlier cut already showed. Distance in TIME never makes two cuts different; only a visible difference does (<distinct_shots>).
</continuity>"""

_VIDEO_MUSIC_SYNC = """<music_sync>
If a <music> block is present in the context above, a background track plays under the final video. When a cut boundary (a new segment, or a new cut inside a line) can land within ~0.15s of a listed beat_timestamps_sec without breaking any other rule, prefer that placement. Soft preference only — never force an awkward or premature cut to chase a beat. With no <music> block, ignore this section.
</music_sync>"""

_VIDEO_ANCHOR = """<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the video you chose for this cut.
- TIME FORMAT: decimal seconds from the start of the clip. You reason about video in MM:SS; convert before writing. A moment at 4:42 is 282.0 — writing 442.0 names a moment that does not exist. Multiply the minutes by 60, never write the digits side by side.
- sourceIn must be ≥ matchedFrameTime − 0.35s — never start the trim earlier to include prep. Starting LATER than the anchor is allowed and is often right: if the action lands a beat after the second you anchored, move sourceIn to where it actually lands.
- sourceOut: check the END as carefully as the start. End the cut while the subject is still in the hold — before the pose drops, before hands start adjusting anything, before anyone moves toward the camera, and before the next action begins. Never extend a cut past its hold to fill time.
- durationSec = sourceOut − sourceIn.
- cutStyle options: "jump_cut" | "standard" | "zoom_in" | "zoom_out" — default to "jump_cut"
- Multiple clips arrive as separately labeled videos (e.g. "=== clip0 ==="); sourceClip must be that exact label, and sourceIn/sourceOut are timestamps within that clip's own video.
- BEFORE any segment, emit "clipBounds": one entry per clip, copying that clip's end time from the <clips> block verbatim, and treat those numbers as the only timestamps that exist. sourceIn can never be negative and sourceOut can never exceed the clip's duration: a value past a clip's end is not a late moment in that clip — it is a moment that was never filmed.
- You see the video as sampled frames, not continuous motion, so a pose that appears only briefly (a quick turn, a flash of a label) is hard to timestamp exactly. Prefer moments that are HELD for at least ~1 second; if a claimed visual is only fleeting, find a held instance elsewhere or do not claim it — a claim the timestamp does not reliably show renders as a mismatch.
</anchor>"""

_VIDEO_LENGTH = """<length>
Length is decided by the strong material, not by a quota. A typical TikTok affiliate review runs about 45 seconds and most strong ones land between 45 and 60 — calibration, not a target to pad toward. Length must scale with the footage: a long shoot rich in strong spans justifies a meaningfully longer cut than a thin one, and a thin one is better served by a short cut made only of strong spans. A short video because the strong material ran out is a correct result.
Every segment must earn its place: if you would cut it from a client's video, cut it from this one. Never invent a timestamp beyond a clip's real duration, and never reuse a moment, just to run longer.
</length>"""


def _video_verify(closing_check: str) -> str:
    return f"""<verify>
Before returning, check each point in English and fix what fails:
- you watched every clip to its FULL given duration and chose on strength wherever it sits — not the first acceptable moment, not a cluster at the start;
- you judged each span before its frames — every cut comes from a span you decided to USE, and no cut comes from a span whose purpose was production rather than content (<reject_span>);
- every strong moment the footage offers — each demonstrated feature, the product worn or in use, a new camera position or setup, a changed state, a part shown on its own, a different distance — is in the cut, unless a rule rejects it;
- no shot appears twice (<distinct_shots>): no moment reused, no second take of an action already shown, no two cuts from neighbouring seconds of one hold — compare every cut with every other cut, not only with its neighbour;
- no cut shows prep — fixing, adjusting, fastening, or setting anything up (<reject_prep>). Reread each visualDescription you wrote: if it describes fastening, adjusting, or putting something in place, that cut shows prep — replace it. A product already on or in use and shown to the camera is the result, not prep;
- every anchor sits inside its span's HOLD — no later moment in that span shows a fuller, more committed version of the same action;
- look at the frame at every sourceOut: if the pose has already dropped, or the hands are already reaching for, fastening, or adjusting anything, move sourceOut earlier. For the last cut taken from each clip, also compare its sourceOut frame with its sourceIn frame: if the subject has grown larger in frame or started toward the camera, the walk to stop the recording has begun — end the cut before it, and when in doubt, half a second earlier;
- go through the segments one by one and compare each sourceOut against that clip's end time in "clipBounds"; if even one is larger, fix it rather than trusting that you stayed in range;
- cuts play in the order the material was given (clip order, then forward in time inside each clip), except a CTA closing on an earlier moment;
- the total follows the strong material (<length>); an explicit target_duration_sec is a ceiling — never exceeded;
- every line's cut pattern follows the <editing_style> section above (re-check each line against it before finalizing); for every multi-angle line, name what a viewer sees change between its cuts and check none are neighbouring seconds of one hold — fix a failing line by pulling a different moment, not by falling back to one long cut;
- {closing_check};
- zero reject_safety violations remain.
</verify>"""


DUB_EDIT_SYSTEM_VIDEO = "\n\n".join([
    """<role>
You are a TikTok affiliate video editor. Produce an Edit Script JSON.
Do ALL reasoning, cataloging, and verification in English. Write voiceoverScript values in Thai.
</role>""",
    """<method>
Work in this order. Finish each step before starting the next.

1. WATCH every clip end to end.
2. SPLIT each clip into spans (<scene_spans>).
3. DECIDE, span by span, whether to use it at all. Apply <reject_span>, then ask whether this span is strong enough to earn screen time when the rest of the footage is competing for it. Dropping most spans of a long take is the normal outcome, not a failure.
4. COLLAPSE repeats (<distinct_shots>): where the same action was filmed more than once, keep only the best take.
5. PICK the single best moment inside each span you kept (<shot_quality>), and trim it so both its start and its end sit inside the action (<anchor>).
6. WRITE the Thai voiceover from the moments you kept.

Step 3 is the one that decides whether the video is good. A frame that survives every rule in <reject_prep> can still sit inside a span that should never have been used — judge the span first, the frame second.
</method>""",
    "__CUT_STYLE_BLOCK__",
    """<video_model>
This pipeline renders a SILENT video from your cuts only — the creator records voiceover AFTER watching it.
totalEstimatedSec = sum of all segment durationSec = the actual silent-video length the creator must fill with narration. There is NO separate voiceover track — durationSec IS the speaking time for that line.
</video_model>""",
    _VIDEO_COVERAGE,
    _VIDEO_SCENE_SPANS,
    _VIDEO_SHOT_QUALITY,
    DISTINCT_SHOTS_BLOCK,
    ALTERNATES_BLOCK,
    _VIDEO_REJECT_SPAN,
    _VIDEO_REJECT_SAFETY,
    _VIDEO_REJECT_PREP,
    _VIDEO_CONTINUITY,
    _VIDEO_MUSIC_SYNC,
    _VIDEO_ANCHOR,
    _VIDEO_LENGTH,
    """<script>
This is step 6 of <method>: the moments are already chosen. Write the script to fit that footage, never footage to fit a line you already wrote. Write a coherent Thai voiceover: hook → product intro → features/demo → result → CTA. Each line describes ONLY what its own cuts show — if no cut shows a claim, do not write that line; a line about how the product looks worn, applied, or in use needs a cut that shows exactly that. Never repeat a point already made.
Hook: the first line must grab attention in its first seconds — not a generic stand-still intro.
Lines: one spoken beat each, 3–6s summed across its cuts — durationSec is all the time the creator gets to say the line, and a Thai feature line needs about 3s or more. A point that needs more than about 6s becomes two lines. Build that length from quick cuts of different moments (<editing_style>), never by stretching one cut past its hold. Write each line to fit the time its cuts give it.
Product lines need a cut where the label/logo is readable; with vague footage, write lifestyle lines instead.
Last line = CTA ("สั่งได้เลยที่ TikTok Shop" / "คลิกลิงค์ใน bio เลย"), matched to a closing moment: the creator facing the camera or presenting the product toward it.
Source: full user_script → keep wording exactly, split into lines of 3–6s. Brief only → write from the brief and the footage. Neither → infer from the footage.
</script>""",
    """<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed). voiceoverScript on the first cut of each line only; omit on subsequent cuts of the same line.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>""",
    _video_verify("the last line is a CTA matched to a closing frame"),
    """<output_format>
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
      "cutStyle": "jump_cut", "voiceoverScript": "เนื้อบางเบา ซึมไว",
      "alternates": [
        { "sourceClip": "clip0", "sourceIn": 31.0, "sourceOut": 34.1, "matchedFrameTime": 31.2,
          "note": "ชิดกว่า เห็นเนื้อครีมชัด แต่แสงมืดกว่า" }
      ]
    },
    {
      "order": 3, "voiceoverLineId": 2,
      "sourceClip": "clip0", "sourceIn": 45.0, "sourceOut": 47.5, "durationSec": 2.5,
      "matchedFrameTime": 45.0, "visualDescription": "ทา demo",
      "cutStyle": "jump_cut"
    }
  ]
}
</output_format>""",
])


DUB_EDIT_SYSTEM_VIDEO_NO_VO = "\n\n".join([
    """<role>
You are a TikTok editor producing an Edit Script JSON for a cut-only highlight reel — NO voiceover, NO narration script. The final video plays with only background music (if provided) plus user-added captions/stickers layered in separately afterward.
Do ALL reasoning in English.
</role>""",
    """<method>
Work in this order. Finish each step before starting the next.

1. WATCH every clip end to end.
2. SPLIT each clip into spans (<scene_spans>).
3. DECIDE, span by span, whether to use it at all. Apply <reject_span>, then ask whether this span is strong enough to earn screen time when the rest of the footage is competing for it. Dropping most spans of a long take is the normal outcome, not a failure.
4. COLLAPSE repeats (<distinct_shots>): where the same action was filmed more than once, keep only the best take.
5. PICK the single best moment inside each span you kept (<shot_quality>), and trim it so both its start and its end sit inside the action (<anchor>).
6. ORDER the moments you kept into the final cut. There is no script to write.

Step 3 is the one that decides whether the video is good. A frame that survives every rule in <reject_prep> can still sit inside a span that should never have been used — judge the span first, the frame second.
</method>""",
    "__CUT_STYLE_BLOCK__",
    """<video_model>
This pipeline renders a SILENT video from your cuts only. There is no voiceover track at all — durationSec is purely how long that cut plays on screen, not "speaking time." Pace cuts per the <editing_style> section (music-driven if a <music> block is given), not for a line of dialogue.
</video_model>""",
    _VIDEO_COVERAGE,
    _VIDEO_SCENE_SPANS,
    _VIDEO_SHOT_QUALITY,
    DISTINCT_SHOTS_BLOCK,
    ALTERNATES_BLOCK,
    _VIDEO_REJECT_SPAN,
    _VIDEO_REJECT_SAFETY,
    _VIDEO_REJECT_PREP,
    _VIDEO_CONTINUITY,
    _VIDEO_MUSIC_SYNC,
    _VIDEO_ANCHOR,
    _VIDEO_LENGTH,
    """<visual_description>
Every segment MUST include visualDescription: a short concrete phrase (Thai or English) naming what's actually on screen — subject, action, framing (e.g. "close-up product label", "demo in use, side angle"). This is the ONLY per-scene context the downstream effects/caption AI will have, since there is no spoken script — be specific, not vague ("nice shot").
Do NOT include a voiceoverScript field on any segment, even though the schema still lists it as available — this mode has no narration at all; leave it out entirely rather than writing filler Thai lines.
</visual_description>""",
    """<grouping>
All cuts under one line share voiceoverLineId (integer, 1-indexed) — a "beat"/scene group sharing one topic/moment.
No fixed segment cap per voiceoverLineId — single-shot is 1 cut; multi-angle uses as many cuts as genuinely add value.
</grouping>""",
    _video_verify("the last cut is a strong closing shot (CTA framing optional — no spoken words to deliver one)"),
    """<output_format>
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
      "cutStyle": "jump_cut",
      "alternates": [
        { "sourceClip": "clip0", "sourceIn": 31.0, "sourceOut": 34.1, "matchedFrameTime": 31.2,
          "note": "มุมชิดกว่า เห็นสินค้าเต็มเฟรม" }
      ]
    }
  ]
}
</output_format>""",
])



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
                    # R18b backup shots: max 3, validated in code (bounds +
                    # overlap) by sanitize_segment_alternates. REQUIRED with an
                    # empty array meaning "no candidate passed": two live runs
                    # (2026-09-01) showed Gemini's enforced decoding simply
                    # never fills an optional field, even when the instruction
                    # tail demands it. sanitize_segment_alternates strips empty
                    # arrays, so the stored contract (no backups = field
                    # absent) is unchanged.
                    "alternates": {
                        "type": "array",
                        "maxItems": 3,
                        "items": {
                            "type": "object",
                            "properties": {
                                "sourceClip": {"type": "string"},
                                "sourceIn": {"type": "number"},
                                "sourceOut": {"type": "number"},
                                "matchedFrameTime": {"type": "number"},
                                "note": {"type": "string"},
                            },
                            "required": [
                                "sourceClip", "sourceIn", "sourceOut",
                                "matchedFrameTime", "note",
                            ],
                        },
                    },
                },
                "required": [
                    "order", "voiceoverLineId", "sourceClip", "sourceIn", "sourceOut",
                    "matchedFrameTime", "cutStyle", "visualDescription", "alternates",
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
    (Claude+frames path) does.

    The live (v2) tail carries only what the system prompt cannot: this
    request's numbers (target, footage length, clip bounds) and the few rules
    measured to need restating where the model reads them last — clip bounds,
    alternates, and (2026-09-21) same-looking cuts and prep. Everything else
    lives once, in the system prompt. It is shared by both modes, so it never
    mentions a voiceover, and it never carries editing-style guidance, which
    would override a saved cut style from the last position the model reads.

    ``version`` follows DUB_PROMPT_VERSION (see select_video_edit_prompts).
    The v1 branch keeps the pre-2026-08-15 sentences verbatim — including the
    "keep adding until 45s+" quota that v2 exists to remove — so the env-var
    rollback restores the whole request, not just the system prompt.
    """
    total_footage = sum(dur for _clip_id, dur in clip_durations)
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
    if _prompt_version(version) == "v1":
        duration_hint = (
            f"Target video length: ~{target_duration_sec} seconds. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Aim for roughly {_line_count_hint(target_duration_sec)} lines (scaled to this target — do NOT default to 12-18 lines, that count is only for the ~45-60s default length and would squeeze every cut far below the 1.5-3.5s range) with multi-angle middle sections so all cuts total ~{target_duration_sec}s, NEVER by inventing timestamps beyond a clip's real duration (see <clips> above). "
            if target_duration_sec
            else f"No target set — minimum 45s, target 50–60s (standard TikTok affiliate length), but this floor is secondary to authenticity: total available footage across all clips is {total_footage:.1f}s. totalEstimatedSec = sum of ALL segment durationSec = actual rendered video length. Plan 12–18 lines (≥10 segments), prefer multi-angle on product/demo/OOTD lines, and add lines until the sum reaches 45s+ ONLY using real distinct moments — if real usable footage runs out sooner, stop there rather than inventing or reusing beyond the reuse limits. "
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

    duration_hint = (
        f"Requested video length: ~{target_duration_sec} seconds — an AIM and a CEILING, never a quota to pad toward. Land close when the strong material supports it; never exceed it; and if the strong spans genuinely run out sooner, deliver the shorter honest cut instead. Roughly {_line_count_hint(target_duration_sec)} lines usually fits this length (calibration, not a count to force). "
        if target_duration_sec
        else f"No target set. Calibration: the strong material decides the length (<length>) — total available footage across all clips is {total_footage:.1f}s, and the cut should scale with how much of it is genuinely strong. "
    )
    return (
        "<instruction>"
        f"{duration_hint}"
        "Based on the video(s) above: watch each clip in full for its ENTIRE given duration before selecting any cuts. "
        # Restated at the tail because directives here are the ones Gemini
        # follows. Both were observed failing live on 2026-09-21 with the rule
        # stated only in the system prompt.
        "Never show the same shot twice: no moment reused, no second take of an action already shown (keep the best take, put the others in its alternates), and no two cuts from neighbouring seconds of one hold. "
        "No cut may show prep — fixing, adjusting, fastening, or setting anything up; a product already on or in use and shown to the camera is the result, not prep — and every cut ends before its hold breaks. "
        f"HARD LIMIT: {bounds_reminder} "
        "Start the JSON with clipBounds echoing those end times, then the segments. "
        # R18b. Restated here for the same reason: a first live run with the
        # block only in the system prompt returned 0/12 segments with
        # alternates (2026-09-01).
        'For each segment, also fill "alternates" (max 3) per the <alternates> rules: the '
        "runner-up moments you compared that still pass every rule, each with a one-line "
        "Thai note — an empty array only when no candidate passes; never pad. "
        "Return ONLY the Edit Script JSON."
        "</instruction>"
    )


def _billed_video_seconds(clip_videos: list[tuple[str, pathlib.Path, float]]) -> float:
    """Σ seconds of the video files a request attaches, as measured on disk
    (the stated duration only when a file cannot be measured — the upload
    route already refused unmeasurable files)."""
    from packages.video.ffmpeg_bin import measured_seconds

    return round(sum(measured_seconds(path, fallback=duration) for _cid, path, duration in clip_videos), 3)


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
    model: str | None = None,
    fps: int | None = None,
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
        pull_back_clip_tails,
    )

    settings = get_settings()
    # ``model`` is the bare provider model id from the project's Engine tier
    # (packages/video/quality.py); unset keeps DUB_VISION_MODEL.
    resolved_model = f"gemini/{model or settings.dub_vision_model}"

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        for _clip_id, path, _duration in clip_videos:
            file_ids.append(await upload_gemini_file(path, mime_type="video/mp4"))
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        clip_durations = [(clip_id, duration) for clip_id, _path, duration in clip_videos]

        def _build_content(sample_fps: int) -> list[dict[str, Any]]:
            """Gemini's long-video guidance: data first, directives last — the
            video blocks sit between the context text and the instruction text.
            Rebuilt rather than mutated so the content-filter fallback below can
            re-issue the identical request at a lower sampling rate."""
            content: list[dict[str, Any]] = [{"type": "text", "text": build_dub_edit_context_text_video(
                brief=brief,
                user_script=user_script,
                clip_durations=clip_durations,
                music_beats=music_beats,
            )}]
            for (clip_id, _path, _duration), file_id in zip(clip_videos, file_ids, strict=True):
                content.append({"type": "text", "text": f"=== {clip_id} ==="})
                content.append(
                    gemini_video_block(file_id, fps=sample_fps, processing=settings.dub_video_processing)
                )
            content.append({"type": "text", "text": build_dub_edit_instruction_text_video(
                target_duration_sec=target_duration_sec,
                clip_durations=clip_durations,
            )})
            content.append({"type": "text", "text": DUB_EDIT_REMINDER})
            return content

        # Frame sampling: explicit arg wins, else the DUB_VISION_FPS setting.
        # 0/None = Gemini's default ~1 fps (today's behavior).
        sample_fps = fps if fps is not None else settings.dub_vision_fps
        messages = [{"role": "user", "content": _build_content(sample_fps)}]
        extra = call_kwargs(model=resolved_model, effort=settings.dub_vision_effort)
        extra["timeout"] = settings.dub_vision_timeout_sec
        # The per-call billing guard prices the footage this request really
        # attaches: each file as measured here, never the length a client
        # stated (packages/billing/guard.py). Popped by the gateway.
        extra["billing_video_sec"] = _billed_video_seconds(clip_videos)
        extra["billing_video_precision"] = "high" if sample_fps > 0 else "standard"
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
            model=resolved_model,
            fps=sample_fps,
            clip_count=len(clip_videos),
            upload_ms=upload_ms,
            # The length inputs, so "why did it come back at Ns" is answerable
            # from logs instead of a code read (2026-09-09: two projects of
            # 2:42 and 10:00 both cut to exactly 0:30 on the no-target path).
            target_duration_sec=target_duration_sec,
            duration_branch="target" if target_duration_sec else "no_target",
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
        # High precision samples ~5x the frames, and a denser read of the same
        # footage is exactly what tips Google's PROHIBITED_CONTENT classifier
        # (measured 2026-09-07: identical clip and frame count passes when the
        # detail is lower). Refusal returns no content at all, so retry once at
        # the provider default rather than failing a job the user paid for.
        # Costs nothing when precision is already standard.
        filter_fallback_used = False
        attempt = 0
        while attempt < MAX_BOUNDS_ATTEMPTS:
            attempt += 1
            if best is None:
                resp = await acompletion_stream_thinking(
                    messages,
                    system=resolved_system,
                    project_uid=project_uid,
                    on_thinking=on_thinking,
                    **extra,
                )
            else:
                # A correction pass is OPTIONAL: a usable answer is in hand, so
                # if the run's budget (packages/billing/guard.py) has no room
                # for another full call, keep that answer rather than stopping
                # the whole job. Lazy import: this module is shared with the
                # desktop sidecar, which has no billing.
                from packages.billing import guard

                try:
                    with guard.optional_call():
                        resp = await acompletion_stream_thinking(
                            messages,
                            system=resolved_system,
                            project_uid=project_uid,
                            on_thinking=on_thinking,
                            **extra,
                        )
                except guard.OptionalCallSkipped:
                    log.warning("dub_bounds_retry_skipped_budget", project_uid=project_uid, attempt=attempt)
                    break
            raw_text = resp.choices[0].message.content or ""
            if not raw_text.strip():
                finish = getattr(resp.choices[0], "finish_reason", None)
                if finish == "content_filter" and sample_fps > 0 and not filter_fallback_used:
                    filter_fallback_used = True
                    log.warning(
                        "dub_video_content_filter_fallback",
                        project_uid=project_uid,
                        from_fps=sample_fps,
                        model=resolved_model,
                    )
                    sample_fps = 0
                    extra["billing_video_precision"] = "standard"
                    messages = [{"role": "user", "content": _build_content(0)}]
                    attempt -= 1  # the refusal never produced an answer to judge
                    continue
                if finish == "content_filter":
                    # The user's footage was refused — input the user controls,
                    # and the refused request's input was still billed. A
                    # user_error run is charged, not refunded (core/errors.py).
                    from packages.core.errors import UserInputError

                    raise UserInputError(
                        "ผู้ให้บริการ AI ปฏิเสธวิดีโอนี้ — ลองตัดคลิปให้สั้นลง "
                        "หรือเลือกช่วงอื่นแล้วลองใหม่"
                    )
            candidate = parse_llm_json(raw_text)
            asked = len([s for s in (candidate.get("segments") or []) if isinstance(s, dict)])
            over = out_of_range_segments(candidate, bounds)
            candidate = pull_back_clip_tails(clamp_dub_segments_to_clip_durations(candidate, bounds), bounds)
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
Classify any newly chosen frame/moment: hook / product-display / close-up / demo / result / full-view / reaction / cta-closing. Mark USE or REJECT against the reject rules below.
</shot_types>

<compare>
When choosing a replacement moment and multiple candidates show essentially the same content, compare them for focus, framing, product/logo visibility, and expression — pick the objectively best one, not just the first that passes USE.
A new or moved cut must also look different at a glance from every other cut in the script. The same framing and subject state with the hands on a different spot is the same shot, however far apart in time.
</compare>

""" + _VIDEO_REJECT_SAFETY + """

""" + _VIDEO_REJECT_PREP + """

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
ALTERNATES: segments in the current edit script may carry an "alternates" array (max 3 backup shots, each with sourceClip/sourceIn/sourceOut/matchedFrameTime and a one-line Thai "note"). Every segment you REVISE must come back with a FRESH alternates set of its own (runners-up for the new moment that pass every reject rule; an empty array when nothing passes — never pad). Every segment you do NOT touch must keep its existing alternates byte-identical — never silently strip them from the script.
</task>

<anchor>
- Every segment MUST include matchedFrameTime: the exact timestamp (seconds) in the RAW clip you chose (not the edited_preview's timeline).
- sourceIn must be within ±0.35s of matchedFrameTime.
- sourceOut: end the cut while the subject is still in the hold — before the pose drops, before hands start adjusting anything, and before the next action begins.
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
    from packages.video.quality import reedit_model
    from packages.video.timeline import (
        clamp_dub_segments_to_clip_durations,
        parse_llm_json,
        pull_back_clip_tails,
    )

    settings = get_settings()
    model = f"gemini/{reedit_model()}"

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
        # Every video this request attaches — the live preview AND each source
        # proxy — at the provider's default sampling (no fps is set here).
        extra["billing_video_sec"] = _billed_video_seconds(
            [("edited_preview", preview_path, _preview_duration), *clip_videos]
        )
        extra["billing_video_precision"] = "standard"
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
        return pull_back_clip_tails(clamped, clip_durations).get("segments") or []
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
    *,
    music_offset_sec: float = 0.0,
    music_trim_in_sec: float = 0.0,
    music_trim_out_sec: float | None = None,
) -> list[dict[str, Any]]:
    """Claude text call mapping Edit Script segments to render cuts.

    ``music_*`` place the attached track on the output timeline (see
    music_beats_on_output); the defaults mean an untrimmed track starting at 0.

    Returns per-clip, length-filtered render cuts (same post-processing the
    worker applies). Raises ValueError on empty/invalid model output.
    """
    from packages.llm.gateway import complete
    from packages.video.timeline import (
        MIN_RENDER_CUT_SEC,
        clamp_per_clip_cuts,
        filter_short_cuts,
        parse_llm_json,
    )

    raw = await complete(
        build_dub_timeline_prompt(
            edit_script,
            vo_duration,
            music_beats_on_output(
                music_beats,
                offset_sec=music_offset_sec,
                trim_in_sec=music_trim_in_sec,
                trim_out_sec=music_trim_out_sec,
            ),
        ),
        system=DUB_TIMELINE_SYSTEM,
    )
    parsed = parse_llm_json(raw)
    raw_cuts = parsed.get("timeline", [])
    if not raw_cuts:
        raise ValueError("AI ไม่ได้ส่ง timeline กลับมา — กดลองใหม่อีกครั้ง")

    # The planner copies each segment's sourceClip + per-clip sourceIn/Out
    # (DUB_TIMELINE_SYSTEM), so the cuts are already local to their source —
    # localize_cuts would re-read them as combined time and play clip1+ shots
    # from clip0.
    render_cuts = filter_short_cuts(
        clamp_per_clip_cuts(raw_cuts, clip_durations),
        min_sec=MIN_RENDER_CUT_SEC,
    )
    if not render_cuts:
        raise ValueError("แผนตัดที่ได้ใช้ไม่ได้ — กดลองใหม่อีกครั้ง")
    return render_cuts
