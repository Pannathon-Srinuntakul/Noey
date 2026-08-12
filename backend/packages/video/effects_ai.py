"""AI-assisted effects placement pass (Gemini).

A SEPARATE stage from the cut/dub AI (own system prompt, own schema, own model
setting). Watches the already-rendered cut video and decides what CAMERA MOTION
to apply to it: focus zoom-holds (``zoomPunches``), whip-pan sweeps across a
real cut (``transitions``), and ambient whole-scene drift (``sceneDrifts``) —
the latter two only when cut timestamps are given.

SCOPE (2026-08-12): motion only. Every output is an ffmpeg filter over the real
footage pixels (packages/video/transforms.py). The former overlay half — a
Remotion component shelf, AI-generated bespoke components, stickers, image
assets, on-screen text/fonts — was removed along with the node-sidecar; parked
in desktop/_removed/. Burned-in captions are a different stage entirely
(packages/video/caption.py, ASS via ffmpeg) and are unaffected.

One optional extra input: a REFERENCE video/image — style inspiration only,
never the actual clip; the model reads its motion rhythm, nothing else.

Output is a normalized EffectsDoc dict (effects.py) with ``source="ai"`` on
every instance, ready to write to effects.json and feed the render engine
(effects_render.py).
"""

from __future__ import annotations

import json
import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger
from packages.video.effects import EFFECTS_PLACEMENT_SCHEMA, EffectsDoc

log = get_logger(__name__)


EFFECTS_PLACEMENT_SYSTEM = """<role>
You are a short-form (TikTok) video editor. You are given a video that is
ALREADY CUT and finished. Your ONLY job is to decide how the CAMERA should move
over that footage — where to push in on a detail, where to sweep across a cut,
where to let a whole shot drift. You do NOT re-cut, re-time, or change the
footage itself. Do ALL reasoning in English.
</role>

__STYLE_BLOCK__
<context>
FIRST, before deciding anything, identify what KIND of clip this actually is
from what you see and hear — a product review/demo (creator handling and
describing an item's real qualities), a talking-head opinion/story, a
tutorial/how-to, an outfit/GRWM clip, a comedy skit, etc. Let that genre set
your DEFAULT rhythm, not a one-size-fits-all "TikTok" template.

For a product-review/demo clip specifically (the most common case for this
affiliate account) — motion is what makes the edit read as professional. Each
distinct feature the creator shows or talks about is a candidate for a
zoom-hold onto that exact detail. Restraint still applies: motion that lands
on nothing in particular is worse than no motion at all.
</context>

<capabilities>
You have exactly THREE tools, and all three move the real footage. There is no
text, no sticker, no graphic, no particle, no glow — nothing is drawn on top of
the video at this stage. Do not ask for any of those; there is nowhere in the
output schema to put them and the renderer cannot produce them.

- `zoomPunches` — zoom in and HOLD on a specific detail inside a shot.
- `transitions` — a whip-pan sweep straddling one REAL cut instant.
- `sceneDrifts` — a continuous gentle drift across one WHOLE scene.

Captions/subtitles are burned in by a completely separate stage from the
transcript — never plan for them, never leave room for them.
</capabilities>

<zoom>
`zoomPunches` is how you push the camera into the real footage to FOCUS on a
specific detail while it is being shown/described — NOT a quick decorative
"punch" that jumps in and snaps back. There is no snap-back: once zoomed in it
HOLDS at that framing for the whole `durationSec`, matching however long that
detail is actually being talked about, then the next instance (or the base
framing) takes over. It is pure numbers applied by ffmpeg, so there is no
per-use cost — call for as many as the clip's content genuinely has distinct
details worth focusing on.

Exactly two ways to GET to the zoomed framing — pick per moment, both then
hold the same way. `rampSec` is YOURS to set (not fixed by the renderer) —
pick a value that actually matches the transition's feel, not a reflex default:
- `style: "push"` — a smooth eased zoom-IN over the transition, like the
  camera itself is moving closer. This is genuinely SLOW in real reference
  footage — think 1.0-2.5s of continuous, visible motion for a deliberate
  reveal (a full second-plus, not a quick flick); use the shorter end of
  that range only for a snappier push, never go below ~0.6s or it reads as
  a cut with extra steps.
- `style: "cut"` — an INSTANT hard cut straight to the already-zoomed
  framing, no camera-move feel at all — like a real edit cut to a close-up
  shot. `rampSec` here should be as close to 0 as the renderer allows
  (0.05-0.1s) — genuinely instant, no visible motion.
Neither is a "punch": both settle into a HOLD, not a bounce. Pick whichever
reads more natural for that specific transition — there's no fixed default.

Decide placement + duration + COUNT entirely from what you SEE and HEAR —
there is no target number, no fixed cadence, and no generic assumption about
how many a "review clip" or any other genre "should" have. Watch for each
distinct detail/feature/reaction the creator actually shows or talks about,
and hold on it for AS LONG AS that beat genuinely lasts in the <script> —
but NEVER hold across a scene cut from <cuts>. End the zoom at or before the
next cut so the following shot opens at normal framing (a zoom that bleeds
one frame into the next scene looks like a glitch). If the beat runs up to a
cut, set `startSec`+`durationSec` so the window ends exactly on that cut —
but if that leaves less than ~0.7s before the cut, move `startSec` earlier
instead of shipping a shorter hold: anything under ~0.7s reads as a single
frame flash, not a deliberate zoom — it looks broken, not fast.
A clip might genuinely want zero. Another might want one on nearly every beat.
Both are correct when that's what the content (and the reference's own rhythm,
if one is given) actually calls for. Do not default to a "safe middle" count
out of habit — go with what you actually observed, even if that means very few
or very many.

For `style: "push"` specifically, do NOT default to spanning the whole scene
either (observed failing in practice: every push starting exactly at the
scene's cut and holding all the way to the next one, every single time).
`startSec` does not have to equal the scene's start, and the hold does not
have to run all the way to the scene's own cut — those are just the OUTER
bounds, not a target to fill. If the detail is only on screen or being
talked about for part of the scene (the back half, a couple seconds in the
middle, right before the cut), push in only for that portion — normal
framing plays before/after within the same continuous shot, which reads
fine since the ease-in/out is itself smooth motion, not a second cut.

`style: "cut"` only needs the ENTRY to land on a real cut — the release does
not. The renderer automatically eases the release back to normal whenever
`durationSec` ends somewhere that is NOT one of the real `<cuts>` (a smooth
fade over a fraction of a second, not a snap), specifically so a mid-scene
release never reads as a fake second cut. So: same freedom as `"push"` —
`startSec`+`durationSec` can end wherever the detail's beat actually ends,
full scene span or a fraction of it, whichever the content calls for. The
only hold-shape that's fixed by the render itself is when the end DOES
coincide with a real cut: that release is forced instant (correct — the
shot is genuinely changing there), regardless of what you set.

- `focusX`/`focusY` (0..1): the REAL on-screen position of the SPECIFIC
  detail you are zooming toward — read the frame at that timestamp, do NOT
  habit-default to dead center `(0.5, 0.5)`.
  HARD RULE: `(0.5, 0.5)` is almost always WRONG for product footage. A
  standing model/product usually sits lower in a 9:16 frame — waist/torso
  details land around `focusY` 0.45-0.65, shoes/floor products around
  0.70-0.88, face/hair around 0.18-0.35. Left/right: if the product is
  off-center, shift `focusX` (e.g. 0.35 / 0.65), do not leave 0.5 out of
  laziness. Only use exact `(0.5, 0.5)` when the detail is LITERALLY in the
  middle of the frame at that second.
- `focusOn` (short English phrase, REQUIRED): name the detail you are
  locking onto BEFORE you pick coordinates — e.g. "pink polka pant waist
  drawstring", "shoe toe box left", "logo on chest". If you cannot name a
  concrete visible detail, do not place that zoom. Then set focusX/focusY
  to that detail's actual position (not the frame center).
- `zoomFrom` / `zoomTo` (1.0-4.0): the framing at the START and at the END of
  the move. `zoomFrom: 1.0` (the common case) opens at normal size and pushes
  IN toward the detail; `zoomTo` 1.2-1.6 is a modest tightening, higher for a
  genuine close-up on a small detail (stitching, a logo, a texture).
  Set `zoomFrom` ABOVE `zoomTo` to run the move the other way — the shot opens
  already tight and OPENS OUT to reveal the wider frame. That is a real
  editing device, not a mistake: use it to open a scene on a detail before
  showing the whole product/outfit, or to release after a punchline. Note the
  entry is a hard cut into the tight framing (the footage plays at normal size
  right up to `startSec`), so an open-out reads as "cut to close-up, then
  reveal" — which is exactly what it is meant to look like. Do not use it more
  than once or twice in a clip; a push-in is still the default move.
- `durationSec`: driven by the actual beat length in the script/footage, not
  a fixed number — typically 1-3s for a feature being described, shorter only
  for a quick beat.
- `driftX`/`driftY`: OPTIONAL camera-plan during the hold. The common case —
  set both EQUAL to `focusX`/`focusY` for a plain static hold once the push
  settles. But for a LONGER hold (roughly 1.5s+) on a wider detail (a whole
  shoe profile, a garment's cut), a real editor often keeps the camera
  drifting slowly across it instead of freezing dead — a slow pan from one
  edge of the detail toward the other while still held at the same zoom
  level. Use this when it genuinely fits the beat's length and content, not
  on every hold — most holds are still better static.
</zoom>

__CUTS_SECTION__
__REFERENCE_SECTION__
<rules>
- If a <script> block is given below: lines are either the EXACT voiceover/
  spoken text with timing, OR — when prefixed `[scene]` — a short description
  of what's visually happening at that timestamp. Use both the same way: as
  the source of WHEN each detail is being shown or discussed, so a zoom lands
  on the beat that actually talks about what you are zooming into. If no
  <script> is given, fall back to visual judgment alone.
- Place motion on SPECIFIC moments, not blanketed across the whole clip.
  Decide the COUNT freely based on what this particular clip calls for — there
  is no target number. Quality over quantity always.
- startSec + durationSec must stay within the video length given below. Never
  place anything past the end.
- Respect the user's instruction below if one is given (density, style).
- Return ONLY the placement JSON matching the schema — `zoomPunches`,
  `transitions` (empty array unless <cuts> is given AND a cut genuinely calls
  for one), `sceneDrifts` (also needs <cuts>; empty array unless the footage/
  reference genuinely calls for continuous handheld-style motion instead of
  discrete zoom-holds). No prose.
</rules>

<examples>
Well-formed `zoomPunches` — focus MUST land on the named detail, not frame
center. Bad (do not emit): `"focusX": 0.5, "focusY": 0.5` while talking about
a waistband. Good:

{
  "startSec": 8.0,
  "durationSec": 2.4,
  "focusOn": "high-waist drawstring of the pink pants",
  "focusX": 0.48,
  "focusY": 0.52,
  "zoomFrom": 1.0,
  "zoomTo": 1.35,
  "style": "push",
  "rampSec": 1.2,
  "driftX": 0.48,
  "driftY": 0.52
}

{
  "startSec": 14.0,
  "durationSec": 2.0,
  "focusOn": "flared pant hem and slippers near floor",
  "focusX": 0.5,
  "focusY": 0.82,
  "zoomFrom": 1.0,
  "zoomTo": 1.4,
  "style": "cut",
  "rampSec": 0.06,
  "driftX": 0.5,
  "driftY": 0.82
}

An OPEN-OUT (`zoomFrom` > `zoomTo`) — opens tight on the logo, then reveals
the whole outfit. Always `style: "push"`; an open-out has to be visible motion,
a `"cut"` open-out is a contradiction:

{
  "startSec": 0.0,
  "durationSec": 2.6,
  "focusOn": "brand logo on the chest",
  "focusX": 0.52,
  "focusY": 0.34,
  "zoomFrom": 1.9,
  "zoomTo": 1.0,
  "style": "push",
  "rampSec": 1.6,
  "driftX": 0.52,
  "driftY": 0.34
}
</examples>
"""

# Conditionally spliced into EFFECTS_PLACEMENT_SYSTEM via plain string.replace
# (NOT str.format — the prompt above contains literal JSON braces in
# <examples> that would collide with format-string syntax).

# The 2-layer split: this fixed prompt is the SCAFFOLD (schema, zoom/transition/
# drift specs, safety clamps). A saved, reusable user STYLE (packages/video/
# effects_style.py, stored per-user in DB) is spliced in here as the
# authoritative style description, demoting the generic density defaults baked
# into <context>/<zoom> the same way the per-run <reference> block does — but
# from cheap stored text, no video re-upload. When no style is chosen the token
# is empty and the defaults apply.
_STYLE_SECTION_PRESENT_TEMPLATE = """<style>
The user has chosen a SAVED CAMERA-MOTION STYLE for this clip, distilled from a
reference they provided earlier.

It is AUTHORITATIVE: it GOVERNS over the generic guidance elsewhere in this
prompt (<zoom>'s cadence advice is a fallback for when no style is set). If it
says almost no zoom, use almost none even where a beat looks focus-worthy; if
it says frequent zoom-holds, add them liberally. Match its cadence, not a safe
middle.

An axis the style does not mention is one nobody observed — treat it as
unchanged guidance, not as permission to do more of it.

<style_description>
__STYLE_PROSE__
</style_description>
</style>
"""
_STYLE_SECTION_ABSENT = ""

_REFERENCE_SECTION_PRESENT = """<reference>
A REFERENCE video/image is attached below, labeled "=== style reference ===".
It is NOT the clip you are placing motion on — it is a separate example of the
EXACT camera style the user wants cloned onto this clip. When a reference is
given, it OVERRIDES the generic density instincts elsewhere in this prompt —
those are fallbacks for when no reference exists. With a reference, MEASURE
what it actually does and MATCH that:

- Watch its zoom rhythm and roughly count it: how many zoom-holds happen, how
  far apart, how tight (subtle push vs hard crop-in), push vs cut vs a mix.
  Convert to a RATE (holds per 10s of content) and apply that same rate to
  THIS clip's duration and beat count — do not copy the reference's raw count
  if this clip is a different length.
- Watch whether it uses discrete zoom-holds on specific details
  (`zoomPunches`) OR a continuous ambient handheld-style drift for the whole
  shot with no specific target (`sceneDrifts`) — these are different camera
  styles, not interchangeable, and the reference tells you which one this
  editor actually uses.
- Watch whether its cuts are plain hard cuts or swept with a whip-pan
  (`transitions`), and how often.

Ignore everything about the reference that is not camera motion — its
captions, graphics, product, colours and subject are not yours to copy. Clone
the MOTION PATTERN precisely; apply it to THIS clip's actual footage.
</reference>
"""
_REFERENCE_SECTION_ABSENT = ""

_CUTS_SECTION_PRESENT = """<transition>
<cuts> below lists the REAL scene-cut instants in this already-merged video
(seconds from the start) — the actual boundaries where the footage jumps from
one shot/angle/location to another. `transitions` (whip-pan) is how you add a
sweep across one of THOSE boundaries so the cut reads as one motion instead
of a hard splice — it only ever touches a cutSec value taken directly from
<cuts>, never an invented timestamp or a moment that isn't an actual cut.

This is RARE and OPTIONAL — most cuts in most clips need nothing at all
(a plain hard cut is completely normal and usually correct). Only reach for
it when the cut itself is a genuine scene/location/angle change that a real
editor would want to smooth with motion (e.g. indoor product shot → outdoor
lifestyle shot), not for an ordinary trim between two similar shots of the
same setup. Zero uses is a valid, common answer. Never use it for every cut.

- `cutSec` — copy EXACTLY one value from <cuts>.
- `durationSec` (0.15-0.5) — the window straddling the cut, split evenly
  before/after; shorter reads as a snappier whip, longer as a softer sweep.
- `direction` — "horizontal" for a side-to-side sweep, "vertical" for
  up/down; pick whichever matches the actual camera/subject motion at that
  cut if there's a visual cue, otherwise horizontal is the safer default.
- `intensity` (0.2-1.0) — how hard the sweep/zoom reads; keep it toward the
  lower end unless the moment is a genuinely big scene change.

<cuts> also lets you mark up `sceneDrifts` — a CONTINUOUS, gentle camera
drift spanning one whole scene (from one cut to the next, or clip start to
the first cut, or the last cut to clip end), for footage that's just
handheld-drifting the entire shot rather than highlighting one specific
detail. This is a DIFFERENT tool from `zoomPunches`: no target detail, no
static hold plateau, just a smooth continuous ease across the full scene
span, resetting at the next cut. Reach for it ONLY when a reference (see
<reference>) shows this ambient-drift style, or when the footage itself is
clearly handheld and continuously moving throughout a scene with no single
detail being highlighted — do NOT use it as a substitute for `zoomPunches`
on a static product-review shot that has real close-up beats; those still
want discrete zoom-holds instead.

- `startSec`/`durationSec` — must span one real scene: `startSec` at clip
  start or exactly at a <cuts> value, `durationSec` reaching exactly the
  next <cuts> value or the clip end. Never a partial scene.
- `zoomFrom`/`zoomTo` (1.0-1.6) — deliberately mild, this is ambient not a
  highlight; a gap of 0.05-0.2 between them is a barely-there drift, up to 1.6
  only for a more noticeable continuous move. `zoomFrom` below `zoomTo` drifts
  slowly IN across the scene; above it drifts slowly OUT (the shot opens up).
  Set them EQUAL for a pure pan with no zoom change at all.
- `direction` — "in" for a plain slow zoom with no pan, or a pan bias
  ("left"/"right"/"up"/"down") if the footage itself seems to drift that way.
Zero uses is the common, correct answer for most clips — this is a niche
tool for a specific handheld-ambient style, not a default.
</transition>
"""
_CUTS_SECTION_ABSENT = ""


def _build_user_text(
    *,
    brief: str,
    user_prompt: str,
    duration_sec: float,
    script_lines: str = "",
    cut_points_sec: list[float] | None = None,
) -> str:
    brief_block = brief.strip() or "(none)"
    prompt_block = user_prompt.strip() or "(none — use your judgment)"
    script_block = (
        f"<script>\n{script_lines.strip()}\n</script>\n"
        if script_lines.strip()
        else ""
    )
    cuts_block = ""
    if cut_points_sec:
        cuts_list = ", ".join(f"{c:.2f}" for c in sorted(cut_points_sec))
        cuts_block = f"<cuts>{cuts_list}</cuts>\n"
    return (
        f"<video_length>{duration_sec:.1f} seconds</video_length>\n"
        f"<creator_brief>{brief_block}</creator_brief>\n"
        f"{script_block}"
        f"{cuts_block}"
        f"<user_instruction>{prompt_block}</user_instruction>\n\n"
        "Watch the whole video, then place camera motion per the rules"
        + (" — match each move to the exact beat in <script>." if script_block else ".")
        + " Return ONLY the placement JSON."
    )


def _zoom_ramp_sec(style: Any, dur: float, model_ramp: Any = None) -> float:
    """The model now picks `rampSec` directly (2026-07-18 — previously hardcoded
    to 0.4s for "push", which live testing showed was far snappier than real
    reference footage's multi-second slow pushes). This just SANITY-CLAMPS the
    model's value per style rather than dictating it:

    - "cut": clamped tight to near-instant (0.05-0.15s) regardless of what the
      model sent — a "cut" with a visible ramp isn't a cut anymore.
    - "push": clamped to a real eased range (0.3-2.5s, and never more than
      half the hold so the ramp doesn't eat the whole window) — wide enough
      for both a snappy push and a slow multi-second reveal.

    Anything other than the literal string "push" is treated as "cut" — the
    model must opt IN to a transition, never gets one by default/typo.
    """
    is_push = str(style) == "push"
    try:
        requested = float(model_ramp)
    except (TypeError, ValueError):
        requested = 0.4 if is_push else 0.05
    if is_push:
        return max(0.3, min(requested, 2.5, dur / 2))
    return max(0.05, min(requested, 0.15))


_IMAGE_SUFFIXES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_VIDEO_SUFFIXES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}


def _guess_mime(path: pathlib.Path, *, default: str) -> str:
    return _IMAGE_SUFFIXES.get(path.suffix.lower()) or _VIDEO_SUFFIXES.get(path.suffix.lower()) or default


async def generate_effects_placement(
    video_path: str | pathlib.Path,
    *,
    brief: str = "",
    user_prompt: str = "",
    script_lines: str = "",
    project_uid: str,
    previous_doc: dict[str, Any] | None = None,
    reference_path: str | pathlib.Path | None = None,
    cut_points_sec: list[float] | None = None,
    style_prompt: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the Gemini motion-placement call over one cut video.

    ``style_prompt`` — OPTIONAL distilled STYLE GUIDE prose (from a saved
    EffectStyle, packages/video/effects_style.py). When non-empty it is spliced
    into the prompt as the authoritative <style> section, demoting the generic
    density defaults; when empty, those defaults apply. This is the primary,
    reusable style path (analysed once, no video re-upload) — the per-run
    ``reference_path`` below is a lighter fallback for one-off use.

    ``cut_points_sec`` — OPTIONAL real scene-cut timestamps (seconds, in the
    already-merged output timeline) the caller knows from its own edit script/
    timeline. When given, the model may place a `transitions` whip-pan sweep
    AT one of these exact instants (see <transition> in the prompt); when
    omitted, `transitions` and `sceneDrifts` are always empty — the model has
    no cut boundaries to anchor them to.

    ``reference_path`` — an OPTIONAL video/image the user attached purely as
    style inspiration (see <reference> in the prompt); never the actual clip.

    Returns a normalized effects.json dict (``{"version", "instances"}``). The
    caller sets the UsageCtx before invoking (same pattern as the dub tasks).
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.effects import EffectInstance
    from packages.video.ffmpeg_bin import media_duration
    from packages.video.timeline import parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.effects_vision_model}"
    video_path = pathlib.Path(video_path)
    duration_sec = media_duration(video_path)
    ref_path = pathlib.Path(reference_path) if reference_path else None

    file_ids: list[str] = []
    try:
        t_upload = time.monotonic()
        file_ids.append(await upload_gemini_file(video_path, mime_type="video/mp4"))
        ref_file_id: str | None = None
        ref_mime = ""
        if ref_path is not None:
            ref_mime = _guess_mime(ref_path, default="video/mp4")
            ref_file_id = await upload_gemini_file(ref_path, mime_type=ref_mime)
            file_ids.append(ref_file_id)
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        style_block = (
            _STYLE_SECTION_PRESENT_TEMPLATE.replace("__STYLE_PROSE__", style_prompt.strip())
            if style_prompt.strip()
            else _STYLE_SECTION_ABSENT
        )
        system = (
            EFFECTS_PLACEMENT_SYSTEM
            .replace("__STYLE_BLOCK__", style_block)
            .replace(
                "__REFERENCE_SECTION__",
                _REFERENCE_SECTION_PRESENT if ref_file_id else _REFERENCE_SECTION_ABSENT,
            )
            .replace(
                "__CUTS_SECTION__",
                _CUTS_SECTION_PRESENT if cut_points_sec else _CUTS_SECTION_ABSENT,
            )
        )
        user_text = _build_user_text(
            brief=brief, user_prompt=user_prompt, duration_sec=duration_sec,
            script_lines=script_lines, cut_points_sec=cut_points_sec,
        )
        # Regenerate = the user REJECTED the current arrangement. Same video +
        # same prompt makes the model converge on a near-identical answer, so
        # feed the rejected doc back and demand a visibly different take.
        if previous_doc and previous_doc.get("instances"):
            prev_json = json.dumps(previous_doc.get("instances", []), ensure_ascii=False)
            # "Different" means different CONTENT (exact timing, focus points,
            # zoom amounts) — NOT a different technique category. Without this
            # guard the model reads "avoid repeating the previous attempt" as
            # license to drop zoomPunches/transitions/sceneDrifts entirely just
            # because the prior take used them, even when a <style> (or the
            # clip itself) genuinely calls for that technique — observed live
            # (2026-07-18): a style whose prose explicitly asked for
            # scene-drift got a fully static regenerate because the rejected
            # take "leaned heavily on scene-drift". The technique choice must
            # keep tracking <style>/<zoom>/<transition> guidance every
            # regenerate; only the specifics should vary.
            style_note = (
                " If a <style> section is given above, its guidance on "
                "WHETHER to use zoomPunches/transitions/sceneDrifts and how "
                "often still applies — do not drop or add that TECHNIQUE "
                "just because the previous attempt used or skipped it; only "
                "the specific moments/timings/framings need to differ."
                if style_prompt.strip()
                else ""
            )
            user_text = (
                "<previous_attempt>\n"
                f"{prev_json}\n"
                "</previous_attempt>\n"
                "The user REJECTED the arrangement in <previous_attempt> and asked to "
                "regenerate. Produce a CLEARLY DIFFERENT take on the SAME content "
                "decisions: different moments, different focus points, different "
                "zoom amounts/timings. Do not repeat any instance verbatim "
                "from the previous attempt." + style_note + "\n\n"
            ) + user_text
        user_content: list[dict[str, Any]] = []
        if ref_file_id:
            user_content += [
                {"type": "text", "text": "=== style reference (NOT the actual clip) ==="},
                gemini_video_block(ref_file_id, mime_type=ref_mime),
            ]
        user_content += [
            {"type": "text", "text": "=== cut video ==="},
            gemini_video_block(file_ids[0]),
            {"type": "text", "text": user_text},
        ]
        messages = [{"role": "user", "content": user_content}]

        # "high" not "medium": this call's failure mode is a plausible-looking
        # but lazy plan (dead-center focus points, one push per scene), which
        # degrades silently instead of erroring — worth the reasoning budget.
        extra = call_kwargs(model=model, effort="high")
        extra["timeout"] = settings.effects_vision_timeout_sec
        if previous_doc and previous_doc.get("instances"):
            # Regenerate: bump sampling temperature so the retake actually varies.
            extra["temperature"] = 1.0
        extra["response_format"] = {
            "type": "json_object",
            "response_schema": EFFECTS_PLACEMENT_SCHEMA,
            "enforce_validation": True,
        }

        log.info(
            "effects_ai_payload",
            project_uid=project_uid,
            model=model,
            duration_sec=round(duration_sec, 1),
            upload_ms=upload_ms,
        )

        resp = await acompletion_stream_thinking(
            messages, system=system, project_uid=project_uid,
            on_thinking=on_thinking, **extra
        )
        raw = resp.choices[0].message.content or ""
        placement = parse_llm_json(raw)
        doc = EffectsDoc(version=1, instances=[])

        # Zoom stage: pure numbers straight onto the real footage via the
        # ffmpeg punch-zoom transform — no per-item model call, so the model
        # can call for as many focus-holds as the clip's content genuinely has.
        zooms = placement.get("zoomPunches") or []
        if isinstance(zooms, list):

            def _clamp01(v: Any, default: float) -> float:
                try:
                    return min(1.0, max(0.0, float(v)))
                except (TypeError, ValueError):
                    return default

            # A hold shorter than this reads as a single-frame flash, not a
            # deliberate zoom (live report 2026-07-19: model-picked cut-clamped
            # durations as low as 0.1s looked like the clip stuttering/glitching
            # rather than zooming at all; bumped 0.35->0.7 same day, 0.35 still
            # read as too short/flashy for a hold the viewer can register).
            _MIN_ZOOM_HOLD_SEC = 0.7

            for j, z in enumerate(zooms):
                if not isinstance(z, dict):
                    continue
                zoom_from = min(4.0, max(1.0, float(z.get("zoomFrom", 1.0) or 1.0)))
                zoom_to = min(4.0, max(1.0, float(z.get("zoomTo", 1.3) or 1.3)))
                # An open-out (zoomFrom > zoomTo) IS the motion — rendering it
                # as a hard cut would leave a static tight frame that then pops
                # back, i.e. no reveal at all. Force the eased path regardless
                # of what the model picked.
                is_open_out = zoom_from > zoom_to + 1e-6
                is_cut_style = str(z.get("style")) != "push" and not is_open_out
                start = max(0.0, min(float(z.get("startSec", 0) or 0), duration_sec - _MIN_ZOOM_HOLD_SEC))
                dur = max(
                    _MIN_ZOOM_HOLD_SEC,
                    min(float(z.get("durationSec", 0.3) or 0.3), duration_sec - start),
                )
                # Punch-zooms must not hold across a scene cut — the new shot
                # would open still zoomed for a beat (live report 2026-07-18).
                # Trim the window so it ends at the next cut (renderer uses a
                # half-open gate, so ending ON the cut clears zoom on that frame).
                # ends_on_real_cut tracks whether the FINAL end value actually
                # lands on a real cut — feeds `hold` below: only a release
                # that coincides with a genuine edit cut should snap back
                # instantly; a deliberate mid-scene release (the model is now
                # explicitly allowed to choose one — see <zoom> prompt) has no
                # real cut underneath, so it must ease back instead, or it
                # reads as a fake, unmotivated cut in continuous footage
                # (live report 2026-07-19). No <cuts> at all → keep the old
                # instant-release default (nothing to compare against).
                ends_on_real_cut = True
                if cut_points_sec:
                    end = start + dur
                    for cut in sorted(cut_points_sec):
                        if start < cut < end - 1e-6:
                            end = cut
                            dur = cut - start
                            if dur < _MIN_ZOOM_HOLD_SEC:
                                # Not enough room before the cut for a
                                # perceptible hold — pull start earlier
                                # instead of shipping a flash-length zoom.
                                start = max(0.0, cut - _MIN_ZOOM_HOLD_SEC)
                                dur = end - start
                            break
                    # Soft snap: the model's own numeric estimate for where the
                    # hold ends is frequently a few frames short of (or past,
                    # already handled above) the true cut — the visible
                    # symptom is a stutter right at the scene change: zoom
                    # releases early (a beat of un-zoomed old footage before
                    # the real cut) or lingers a hair into the new shot (live
                    # report 2026-07-19). Pull the end exactly onto the
                    # nearest real cut whenever it's already close.
                    nearest_cut = min(cut_points_sec, key=lambda c: abs(c - end))
                    if nearest_cut > start and abs(nearest_cut - end) <= 0.4:
                        end = nearest_cut
                        dur = end - start
                        if dur < _MIN_ZOOM_HOLD_SEC:
                            start = max(0.0, end - _MIN_ZOOM_HOLD_SEC)
                            dur = end - start
                    ends_on_real_cut = abs(nearest_cut - end) < 0.05
                    # "cut" style is meant to read as a real edit cut straight
                    # into a close-up — that only works when startSec lands on
                    # an actual scene-cut boundary; a mid-scene start still
                    # hard-snaps to zoom_to instantly (correct per the filter)
                    # but has no real cut underneath to justify the pop, so it
                    # reads as an unmotivated glitch instead of a deliberate
                    # cut (live report 2026-07-19). Snap startSec onto the
                    # nearest real cut when already close, same idea as the
                    # end soft-snap above — but only if it doesn't collapse
                    # the hold below the minimum.
                    if is_cut_style:
                        nearest_start_cut = min(cut_points_sec, key=lambda c: abs(c - start))
                        if nearest_start_cut < end and abs(nearest_start_cut - start) <= 0.4:
                            candidate_dur = end - nearest_start_cut
                            if candidate_dur >= _MIN_ZOOM_HOLD_SEC:
                                start = nearest_start_cut
                                dur = candidate_dur
                ramp = _zoom_ramp_sec(
                    "push" if is_open_out else z.get("style"), dur, z.get("rampSec")
                )
                focus_x = _clamp01(z.get("focusX"), 0.5)
                focus_y = _clamp01(z.get("focusY"), 0.5)
                focus_on = str(z.get("focusOn") or "").strip()
                # Soft nudge away from lazy dead-center when the model named a
                # detail but still emitted 0.5/0.5 (common Gemini habit). A tiny
                # offset alone won't find the product — logging flags it so we
                # can spot regressions; the prompt + focusOn field are the real fix.
                if abs(focus_x - 0.5) < 0.02 and abs(focus_y - 0.5) < 0.02:
                    log.warning(
                        "effects_ai_zoom_center_focus",
                        project_uid=project_uid,
                        focusOn=focus_on[:80] or "(missing)",
                        startSec=start,
                    )
                doc.instances.append(EffectInstance(
                    id=f"zoom_ai_{j}",
                    kind="transform",
                    componentId="punch-zoom",
                    startSec=round(start, 2),
                    durationSec=round(dur, 2),
                    zOrder=0,
                    props={
                        "zoomFrom": zoom_from,
                        "zoomTo": zoom_to,
                        "focusX": focus_x,
                        "focusY": focus_y,
                        "rampSec": ramp,
                        # true → snap back instantly at the window's end
                        # (correct when that end IS a real cut — the shot
                        # actually changes there). false → ease back to
                        # normal before the window ends (a deliberate
                        # mid-scene release with no real cut underneath).
                        # See ends_on_real_cut above and punch_zoom_filter.
                        "hold": "true" if (ends_on_real_cut or is_open_out) else "false",
                        # "cut" style → a genuine hard cut to the new crop, no
                        # ramp at all (rampSec above is unused in that case,
                        # kept only so a later manual UI edit toward "push"
                        # has a sane starting value). See punch_zoom_filter.
                        "cut": "true" if is_cut_style else "false",
                        # Model may equal these to focusX/focusY for a static
                        # hold (the common case) — only a genuine hold-drift
                        # pan differs.
                        "driftX": _clamp01(z.get("driftX"), focus_x),
                        "driftY": _clamp01(z.get("driftY"), focus_y),
                    },
                    source="ai",
                ))
            if zooms:
                log.info("effects_ai_zooms_ok", project_uid=project_uid, count=len(zooms))

        # Transition stage: whip-pan sweeps straddling a REAL cut instant —
        # same pure-numbers reasoning as zoomPunches, but only meaningful (and
        # only requested by the prompt) when cut_points_sec was actually
        # provided; snapped to the nearest real cut so a near-miss timestamp
        # from the model still lands on the true boundary.
        transitions = placement.get("transitions") or []
        if isinstance(transitions, list) and transitions and not cut_points_sec:
            # The model wanted transitions but the caller gave no <cuts> to
            # anchor them to — genuinely observed live (2026-07-18): a model
            # plan gets silently discarded here with zero trace otherwise.
            log.warning(
                "effects_ai_transitions_dropped_no_cuts",
                project_uid=project_uid, count=len(transitions),
            )
        if isinstance(transitions, list) and cut_points_sec:
            for m, tr in enumerate(transitions):
                if not isinstance(tr, dict):
                    continue
                try:
                    cut_at = float(tr.get("cutSec", 0) or 0)
                except (TypeError, ValueError):
                    continue
                nearest = min(cut_points_sec, key=lambda c: abs(c - cut_at))
                dur = max(0.15, min(float(tr.get("durationSec", 0.3) or 0.3), 0.5))
                start = max(0.0, min(nearest - dur / 2, duration_sec - 0.05))
                dur = max(0.05, min(dur, duration_sec - start))
                direction = str(tr.get("direction", "horizontal"))
                if direction not in ("horizontal", "vertical"):
                    direction = "horizontal"
                intensity = max(0.2, min(1.0, float(tr.get("intensity", 0.6) or 0.6)))
                doc.instances.append(EffectInstance(
                    id=f"trans_ai_{m}",
                    kind="transform",
                    componentId="whip-pan",
                    startSec=round(start, 2),
                    durationSec=round(dur, 2),
                    zOrder=0,
                    props={"direction": direction, "intensity": intensity},
                    source="ai",
                ))
            if transitions:
                log.info("effects_ai_transitions_ok", project_uid=project_uid, count=len(transitions))

        # Scene-drift stage: continuous ambient zoom/pan spanning one WHOLE
        # scene (cut to cut), for handheld-style footage with no specific
        # detail to highlight — distinct tool from zoomPunches. Only
        # meaningful with real cut boundaries, same gate as transitions.
        # Model-given start/duration are SNAPPED to the nearest actual scene
        # boundaries (0, each real cut, and clip end) so a near-miss timestamp
        # still spans a true scene rather than an arbitrary partial window.
        scene_drifts = placement.get("sceneDrifts") or []
        if isinstance(scene_drifts, list) and scene_drifts and not cut_points_sec:
            log.warning(
                "effects_ai_scene_drifts_dropped_no_cuts",
                project_uid=project_uid, count=len(scene_drifts),
            )
        if isinstance(scene_drifts, list) and cut_points_sec:
            boundaries = sorted({0.0, duration_sec, *cut_points_sec})

            def _nearest_boundary(t: float) -> float:
                return min(boundaries, key=lambda b: abs(b - t))

            _DIRECTION_BIAS = {
                "left": (0.5, 0.5, 0.15, 0.5),
                "right": (0.5, 0.5, 0.85, 0.5),
                "up": (0.5, 0.5, 0.5, 0.15),
                "down": (0.5, 0.5, 0.5, 0.85),
                "in": (0.5, 0.5, 0.5, 0.5),
            }

            for n, sd in enumerate(scene_drifts):
                if not isinstance(sd, dict):
                    continue
                try:
                    raw_start = float(sd.get("startSec", 0) or 0)
                    raw_end = raw_start + float(sd.get("durationSec", 1.0) or 1.0)
                except (TypeError, ValueError):
                    continue
                scene_start = _nearest_boundary(raw_start)
                later = [b for b in boundaries if b > scene_start]
                scene_end = min(later, key=lambda b: abs(b - raw_end)) if later else duration_sec
                if scene_end <= scene_start:
                    continue
                drift_from = max(1.0, min(1.6, float(sd.get("zoomFrom", 1.0) or 1.0)))
                drift_to = max(1.0, min(1.6, float(sd.get("zoomTo", 1.15) or 1.15)))
                direction = str(sd.get("direction", "in"))
                fx0, fy0, fx1, fy1 = _DIRECTION_BIAS.get(direction, _DIRECTION_BIAS["in"])
                doc.instances.append(EffectInstance(
                    id=f"drift_ai_{n}",
                    kind="transform",
                    componentId="scene-drift",
                    startSec=round(scene_start, 2),
                    durationSec=round(scene_end - scene_start, 2),
                    zOrder=0,
                    props={
                        "zoomFrom": drift_from,
                        "zoomTo": drift_to,
                        "focusFromX": fx0,
                        "focusFromY": fy0,
                        "focusToX": fx1,
                        "focusToY": fy1,
                    },
                    source="ai",
                ))
            if scene_drifts:
                log.info("effects_ai_scene_drifts_ok", project_uid=project_uid, count=len(scene_drifts))

        log.info("effects_ai_done", project_uid=project_uid, instances=len(doc.instances))
        return doc.model_dump()
    finally:
        await delete_gemini_files(file_ids)
