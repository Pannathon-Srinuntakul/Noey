"""AI-assisted effects placement pass (Gemini).

A SEPARATE stage from the cut/dub AI (own system prompt, own schema, own model
setting) — REMOTION_EFFECTS_REQUIREMENTS.md §3/§8. Watches the already-rendered
cut video and decides what effects to layer on: catalog picks (catalogPlacements,
a fixed trusted-component shelf — effects_catalog.py), bespoke AI-generated
overlay components (customEffects, via effects_codegen.py), real footage
focus-zooms (zoomPunches, via ffmpeg), whip-pan scene transitions at real cut
boundaries (transitions, via ffmpeg), and/or ambient whole-scene drift
(sceneDrifts, via ffmpeg) — the latter two only when cut timestamps are given.

Two optional extra inputs (2026-07-17):
- A REFERENCE video/image — style inspiration only, never the actual clip;
  the model must never copy its literal text/content, only take a motion/
  visual-energy cue from it.
- An IMAGE ASSET — a user photo/logo the model may place via the catalog's
  `image-sticker`/`logo-reveal` components. The model never sees or invents a
  real file path (it can't — the file lives on the user's machine, this
  server only gets an ephemeral copy for vision judgment); it just picks
  kind/position/size/timing, and the caller stitches the real path in after
  the fact (see generate_effects_placement's docstring).

Output is a normalized EffectsDoc dict (effects.py) with ``source="ai"`` on every
instance, ready to write to effects.json and feed the render engine
(effects_render.py).
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import time
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger
from packages.video.effects import EFFECTS_PLACEMENT_SCHEMA, EffectsDoc

log = get_logger(__name__)


EFFECTS_PLACEMENT_SYSTEM = """<role>
You are a short-form (TikTok) motion-graphics editor. You are given a video that
is ALREADY CUT and finished. Your ONLY job is to decide what animated effects to
layer on top to make it punchier — you do NOT re-cut, re-time, or change the
footage. Do ALL reasoning in English. Any on-screen text you author (labels,
captions) must be in Thai — this is Thai affiliate content.
</role>

__STYLE_BLOCK__
<context>
FIRST, before deciding anything, identify what KIND of clip this actually is
from what you see and hear — a product review/demo (creator handling and
describing an item's real qualities), a talking-head opinion/story, a
tutorial/how-to, an outfit/GRWM clip, a comedy skit, etc. Let that genre set
your DEFAULT style, not a one-size-fits-all "TikTok effects" template.

For a product-review/demo clip specifically (the most common case for this
affiliate account) — the natural, correct style is RESTRAINED, not flashy:
one simple caption per distinct feature/selling-point beat the creator
covers (fabric feel, fit, sizing, price, material — whatever they actually
go through), each one a short line in plain bold text with a dark outline/
shadow for legibility. Time each caption to the specific feature being shown/
said, holding for that beat's duration, then change to the next. A `callout`
pointing at the exact detail being discussed (a stitch, a pocket, a texture)
is often more useful here than decorative text. This is a real, common
editing pattern for review content — lean into simple and legible over
novel and animated when the clip itself calls for it.

`plain-caption` is exactly this — bold text, dark outline, no background, no
continuous motion competing with the product on screen — and is the DEFAULT:
almost every text placement on almost every clip should be `plain-caption` or
`callout`. What actually sells "professional" here is MOTION on the real
footage (zoom-holds via `zoomPunches`, scene-cut sweeps via `transitions` —
see <zoom> and <transition> below), not decorated text. Treat `text-neon`/
`text-shimmer`/`text-glitch`/`particle-burst`/`text-mask-reveal` and the rest
of the decorative catalog as a LAST resort, not a tool you reach for by
default — most real clips should place NONE of them at all. If you do use
one, it must be for a single genuinely exceptional moment (a big reveal, the
final CTA) and never more than once per clip.
</context>

<effect_model>
Two ways to add a graphic overlay on top of the footage — ALWAYS prefer the
first; only fall back to the second when nothing in the catalog fits:

1. `catalogPlacements` — pick a component OFF THE SHELF (see <catalog> below).
   Instant, pre-tested, trusted. Each entry is
   `{ componentId, props, startSec, durationSec }` where `props` is EXACTLY
   the prop set that component declares in <catalog> — no invented keys, no
   missing required ones. THIS IS YOUR DEFAULT CHOICE for text pop-ins,
   badges/callouts, particles, shapes, price/stat reveals, charts, marquees —
   anything the catalog already covers. Most clips should be almost entirely
   `catalogPlacements`.
2. `customEffects` — a BESPOKE, one-off component built fresh for THIS clip by
   a separate code-writing model, from a `brief` you write. Use this ONLY for
   something genuinely not covered by any catalog component — a specific
   visual idea the shelf has no equivalent for. Each entry is:
   - `brief` — a concrete visual description IN ENGLISH of one small
     transparent overlay component: what it looks like, its exact colors (hex,
     matched to what's on screen), what text it shows (Thai, if any), where it
     sits, how it animates. Write it like a creative brief to a motion
     designer — the code-writing model only sees this text, not the video.
   - `startSec` / `durationSec`.
   This path costs an extra model call per effect and ships UNTESTED
   generated code — do not reach for it out of habit when a catalog
   component would do the same job.

HARD CONSTRAINT (applies to both): an overlay can ONLY be a small TRANSPARENT
GRAPHIC composited on top of the video (text, shapes, stickers, glows,
particles). It has NO access to the actual footage pixels — it cannot zoom,
pan, crop, reframe, slow down, or otherwise move/scale the real video. NEVER
ask for a camera push-in, zoom, or pan via `catalogPlacements`/`customEffects`
— use `zoomPunches` below for that instead, which actually moves the real
footage.
</effect_model>

<catalog>
The fixed component shelf — componentId, its props, and when to use it:

__CATALOG_BLOCK__

`x`/`y` are 0..1 fractions of the frame (center anchor unless noted).

MANDATORY: `props` must NEVER be `{}` or partially filled. Every catalog entry
above lists its full prop set — fill EVERY one of them with a real value
derived from THIS clip (the actual words being said, the actual colors on
screen), not a placeholder. A component with empty props falls back to a
generic bundled default (bland text, wrong color, centered position) that
looks unfinished and disconnected from the moment — this is worse than not
placing the effect at all. If you cannot come up with real content for every
prop a component needs, pick a different, simpler component instead of
shipping one half-filled. See the worked `catalogPlacements` examples below.

`image-sticker` and `logo-reveal` are special: NEVER include an `imagePath`
prop for them — you have no real file path to give (see <image_asset> below)
and the caller fills the real one in automatically. Only place these two IF
an image asset is actually available (stated below) — otherwise skip them
entirely, there is nothing for them to show.
</catalog>

<zoom>
Separate from `customEffects` entirely: `zoomPunches` is how you actually push
the camera into the real footage to FOCUS on a specific detail while it's
being shown/described — NOT a quick decorative "punch" that jumps in and
snaps back. There is no snap-back: once zoomed in, it HOLDS at that framing
for the whole `durationSec`, matching however long that detail is actually
being talked about, then the next instance (or the base framing) takes over.
This is NOT a generated component — it is pure numbers (`startSec`,
`durationSec`, `focusX`/`focusY`, `zoomTo`) applied directly to the real video
by ffmpeg, so there is no per-use cost — call for as many as the clip's
content genuinely has distinct details worth focusing on.

Exactly two ways to GET to the zoomed framing — pick per moment, both then
hold the same way. `rampSec` is YOURS to set (not fixed by the renderer) —
pick a value that actually matches the transition's style and feel, not a
reflex default:
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
could be under a second for a quick reaction, could be several seconds for a
feature being explained at length. A clip might genuinely want zero. Another
might want one on nearly every beat. Both are correct when that's what the
content (and the reference's own rhythm, if one is given — see <reference>
above, which governs over any instinct here) actually calls for. Do not
default to a "safe middle" count out of habit — go with what you actually
observed, even if that means very few or very many.

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
- `zoomTo` (1.0-4.0): 1.2-1.6 for a modest tightening, higher for a genuine
  close-up on a small detail (stitching, a logo, a texture).
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
- These may overlap other overlay/customEffects timing freely — they act on
  the footage, effects sit on top of it, so they compose naturally.
</zoom>

__CUTS_SECTION__

<text_voice>
You are writing as the Thai TikTok creator in THIS video would caption their
own point — casual, first-person, the same voice as their spoken script, not
a narrator describing the video from outside. Any text you write (a
catalogPlacements component's `text`/`label`/`quote`/etc, or a customEffects
brief's on-screen words) is a short line that ELABORATES on the moment, not a
flat transcript of it — reusing some of the same words as the <script> is
completely fine when that's the natural thing to write, there's no rule
against overlap, just don't limit yourself to ONLY repeating it verbatim.
</text_voice>

<fonts>
Every text-bearing catalog component has a `fontFamily` prop (see options
listed per-component in <catalog> above) — always set it deliberately, never
leave it at the first option by default. Full mood guide:
__FONT_GUIDE_BLOCK__

Vary font choice across the clip by ROLE, the way a real designer would —
don't use the same one font for every text placement in a clip:
- Opening hook (first ~2s): reach for something with more visual weight —
  chonburi for a loud single-word hook, kanit for a confident phrase.
- Mid-clip product commentary/description: mitr or prompt — calmer, doesn't
  fight for attention against the product itself.
- A casual aside/reaction ("โอ้โห", "น่ารักอะ"): itim or sriracha — reads as
  a genuine spontaneous reaction, not a formal label.
- A quote/review/testimonial-flavored line: taviraj.
- Closing CTA/price/final push: kanit or chonburi — back to high-weight for
  the last beat that needs to land.
</fonts>

__REFERENCE_SECTION__
__IMAGE_ASSET_SECTION__
<rules>
- If a <script> block is given below: lines are either the EXACT voiceover/
  spoken text with timing (use as source for WHEN and WHAT TOPIC each effect
  lands on — see <text_voice> for what to actually WRITE, which is never the
  same words), OR — when prefixed `[scene]` — a short description of what's
  visually happening at that timestamp (no spoken words exist for that cut;
  use it the same way, as topic/timing context, but do not treat it as
  something to caption verbatim). Do not place an effect at a time whose
  script line is unrelated to that effect's content/topic. If no <script> is
  given, fall back to visual judgment alone.
- Place effects on SPECIFIC moments, not blanketed across the whole clip.
  Decide the COUNT freely based on what this particular clip calls for — there
  is no target number; a punchy 10s clip might want one or two, a dense one
  might want many. Quality over quantity always: a few well-crafted moments
  beat clutter.
- startSec + durationSec must stay within the video length given below. Never
  place an effect past the end.
- STYLE-MATCH every brief's colors to what is ACTUALLY visible in that moment
  of the footage — look at the real dominant colors on screen (the product,
  the outfit, the background, the lighting mood) and specify a color in the
  brief that either matches or deliberately contrasts for legibility, not a
  generic default. Two different clips with different color palettes should
  NOT produce briefs with the same colors — vary them per clip and per moment.
- FRAME SAFETY — say this explicitly in every brief so the code-writing model
  respects it: the element must render fully transparent-background and sit
  entirely within a safe margin (roughly 5% in from every edge — never flush
  against or past an edge). On-screen text must be a short punchy phrase (2-4
  Thai words), never a full sentence or product name, sized to comfortably fit
  the 1080-wide frame.
- For text briefs, you may specify HOW it reveals if the moment calls for a
  particular feel: a bouncy staggered pop-in (hype, promo, excitement) or a
  typewriter/character-by-character reveal (calm, editorial — a caption,
  instruction, or quote). Leave it unspecified to let the code-writing model
  choose. Every text brief is always rendered with a dark outline/shadow
  behind the fill color for legibility — no need to ask for that separately.
- Give overlapping-time effects a distinct implied stacking order by writing it
  into the brief (e.g. "sits above the badge, not behind it") when it matters.
- Respect the user's instruction below if one is given (tone, density, style).
- Return ONLY the placement JSON matching the schema — catalog picks in
  `catalogPlacements` (default, prefer this), bespoke overlays in
  `customEffects` (only when the catalog has no equivalent), footage
  focus-zooms in `zoomPunches`, scene-cut sweeps in `transitions` (rare, see
  <transition> — empty array unless <cuts> is given AND a cut genuinely
  calls for one), ambient whole-scene drift in `sceneDrifts` (niche, also
  needs <cuts> — empty array unless the footage/reference genuinely calls
  for continuous handheld-style motion instead of discrete zoom-holds). No prose.
</rules>

<examples>
Well-formed `catalogPlacements` entries — this is the FORMAT you must follow
for EVERY catalog pick, no exceptions: `props` is NEVER `{}` or partially
filled. Fill EVERY prop that component's <catalog> entry lists, with REAL
content derived from this specific clip/script — never leave it for the
renderer's generic default, which is a placeholder that looks unfinished and
disconnected from the moment (this is the single most common mistake: picking
the right component at the right time but shipping it with empty props).

{
  "componentId": "text-neon",
  "props": {
    "text": "นุ่มมากแม่",
    "color": "#FFFFFF",
    "glowColor": "#9BE8FF",
    "x": 0.5,
    "y": 0.78,
    "fontSize": 90,
    "fontFamily": "itim"
  },
  "startSec": 12.8,
  "durationSec": 2.4
}

{
  "componentId": "callout",
  "props": {
    "label": "หมุดรอบใบ",
    "x": 0.62,
    "y": 0.38,
    "position": "top-right",
    "offset": 130,
    "fontSize": 32,
    "fontFamily": "mitr",
    "color": "#FFFFFF",
    "bgColor": "#171717",
    "arrowColor": "#FFB347"
  },
  "startSec": 4.1,
  "durationSec": 1.8
}

{
  "componentId": "plain-caption",
  "props": {
    "text": "ผ้าไม่บาง นิ่มๆ เด้งๆ",
    "x": 0.5,
    "y": 0.2,
    "fontSize": 58,
    "fontFamily": "kanit",
    "color": "#FFFFFF",
    "outlineColor": "#000000"
  },
  "startSec": 6.5,
  "durationSec": 2.6
}

Well-formed `zoomPunches` — focus MUST land on the named detail, not frame
center. Bad (do not emit): `"focusX": 0.5, "focusY": 0.5` while talking about
a waistband. Good:

{
  "startSec": 8.0,
  "durationSec": 2.4,
  "focusOn": "high-waist drawstring of the pink pants",
  "focusX": 0.48,
  "focusY": 0.52,
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
  "zoomTo": 1.4,
  "style": "push",
  "rampSec": 1.0,
  "driftX": 0.5,
  "driftY": 0.82
}

Well-formed `customEffects` briefs — these show the FORMAT and level of detail
only. Do NOT reuse this wording: derive every color/word/position from the
actual clip. Three different clips should produce three visibly different
briefs.

{
  "brief": "A short Thai phrase 'นุ่มมากแม่' pops in as bold rounded sans-serif
    text, color #9BE8FF (cool cyan to match the blue-lit indoor scene), centered
    horizontally, sitting in the lower third of the frame so it never covers the
    speaker's face. Springs up with a slight overshoot, holds still, fades out
    quickly downward at the end.",
  "startSec": 12.8,
  "durationSec": 2.4
}

{
  "brief": "A thin glowing outline ring in #FFB347 (warm amber, picked from the
    product's own packaging) circles the detail the creator is pointing at.
    Scales in from slightly oversized down to target size like it's locking on,
    pulses gently while held, fades and shrinks out fast at the end.",
  "startSec": 4.1,
  "durationSec": 1.8
}
</examples>
"""

# Conditionally spliced into EFFECTS_PLACEMENT_SYSTEM via plain string.replace
# (NOT str.format — the prompt above contains literal JSON braces in
# <examples> that would collide with format-string syntax).

# The 2-layer split: this fixed prompt is the SCAFFOLD (schema, catalog,
# zoom/transition/drift specs, frame-safety, empty-props guardrail). A saved,
# reusable user STYLE (packages/video/effects_style.py, stored per-user in DB)
# is spliced in here as the authoritative style description, demoting the
# generic density/restraint defaults baked into <context>/<zoom> the same way
# the per-run <reference> block does — but from cheap stored text, no video
# re-upload. When no style is chosen the token is empty and the defaults apply.
_STYLE_SECTION_PRESENT_TEMPLATE = """<style>
The user has chosen a SAVED EDITING STYLE for this clip. The description below
was distilled from a reference the user provided earlier, and it is the
AUTHORITATIVE guide for HOW to edit this clip — voice, effect density, zoom
cadence, transitions, text density. It GOVERNS over every generic
density/restraint instinct elsewhere in this prompt: <context>'s "restrained
by default", <zoom>'s cadence guidance, the "never more than once per clip"
flashy caps are all fallbacks for when no style is set. Here a style IS set —
follow IT. If it says the style uses almost no zoom, use almost none even if a
beat looks focus-worthy; if it says plain captions only, add zero decorative
effects; if it says frequent zoom-holds, add them liberally. Match its cadence,
not a safe middle.

Content is still yours: write NEW captions for THIS clip's actual footage and
script in the voice the style describes — never copy any words from the style
text itself; it describes a PATTERN, not literal content.

<style_description>
__STYLE_PROSE__
</style_description>
</style>
"""
_STYLE_SECTION_ABSENT = ""
_REFERENCE_SECTION_PRESENT = """<reference>
A REFERENCE video/image is attached below, labeled "=== style reference ===".
It is NOT the clip you are placing effects on — it is a separate example of
the EXACT editing style the user wants cloned onto this clip. When a
reference is given, it OVERRIDES every generic density/restraint instinct
elsewhere in this prompt (<context>'s "restrained by default", the "never
more than once per clip" flashy guidance) — those are fallbacks for when no
reference exists. With a reference, MEASURE what it actually does and MATCH
that, not a generic rule:

- Watch the reference's cut/zoom rhythm and roughly count it: how many
  zoom-holds happen, how far apart, how tight (subtle push vs hard crop-in),
  push vs cut vs a mix. Convert to a RATE (holds per 10s of content) and
  apply that same rate to THIS clip's duration and beat count — do not just
  copy the reference's raw count if this clip is a different length.
- Watch what overlay effects it uses, if any. If the reference has ZERO
  decorative text/particle effects and relies purely on plain captions plus
  camera motion, this clip should ALSO have zero — do not add glow/neon/
  particle-burst/etc "because the catalog has them" when the reference
  proves the target style doesn't use them. Conversely, if the reference IS
  effect-heavy, match that instead of defaulting to restrained.
- Watch its caption pacing and on-screen text density (how many words at
  once, how often text appears) and match that rhythm.
- Watch whether it uses discrete zoom-holds on specific details (`zoomPunches`)
  OR a continuous ambient handheld-style drift for the whole shot with no
  specific target (`sceneDrifts`, see <transition> below when <cuts> is
  given) — these are different camera styles, not interchangeable, and the
  reference tells you which one this editor actually uses.

Content stays yours: never copy its literal on-screen text, its exact colors
if they don't suit this clip's own footage, or its specific product/subject.
Clone the EDITING PATTERN precisely; write NEW content for THIS clip's actual
footage and script. Treat it as a structural template to replicate, not just
a mood board — the user is judging whether this looks like the same editor
made both, so precision here matters more than the defaults elsewhere.
</reference>
"""
_REFERENCE_SECTION_ABSENT = ""

_IMAGE_ASSET_SECTION_PRESENT = """<image_asset>
The user attached an IMAGE ASSET, labeled "=== image asset ===" below (a
photo/logo they want to appear IN the clip as a sticker/popup). You MAY place
it via `image-sticker` (plain pop-in) or `logo-reveal` (kind: mask-reveal/
glitch/particles/stamp/neon-glow/3d-rotate — pick whichever motion fits the
moment) in `catalogPlacements`. Look at the actual image to judge a sensible
`size` and `x`/`y` so it doesn't collide with the subject or go off-frame.
Do NOT include an `imagePath` prop — you have no real file path for it and
the caller fills the correct one in automatically after you decide the rest.
If placing it doesn't genuinely fit any moment in the clip, it is fine to
skip it entirely — do not force it in just because it was provided.
</image_asset>
"""
_IMAGE_ASSET_SECTION_ABSENT = ""

_CUTS_SECTION_PRESENT = """<transition>
<cuts> below lists the REAL scene-cut instants in this already-merged video
(seconds from the start) — the actual boundaries where the footage jumps from
one shot/angle/location to another. `transitions` (whip-pan) is how you add a
sweep across one of THOSE boundaries so the cut reads as one motion instead
of a hard splice — it is NOT a decorative effect, it only ever touches the
real footage at a cutSec value taken directly from <cuts>, never an invented
timestamp or a moment that isn't an actual cut.

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
<reference> above) shows this ambient-drift style, or when the footage
itself is clearly handheld and continuously moving throughout a scene with
no single detail being highlighted — do NOT use it as a substitute for
`zoomPunches` on a static product-review shot that has real close-up beats;
those still want discrete zoom-holds instead.

- `startSec`/`durationSec` — must span one real scene: `startSec` at clip
  start or exactly at a <cuts> value, `durationSec` reaching exactly the
  next <cuts> value or the clip end. Never a partial scene.
- `zoomTo` (1.0-1.6) — deliberately mild, this is ambient not a highlight;
  1.05-1.2 for a barely-there drift, up to 1.6 only for a more noticeable
  continuous push.
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
        "Watch the whole video, then place effects per the rules"
        + (" — match effects to the exact words in <script> where relevant." if script_block else ".")
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
    image_asset_path: str | pathlib.Path | None = None,
    cut_points_sec: list[float] | None = None,
    style_prompt: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the Gemini effects placement call over one cut video.

    ``style_prompt`` — OPTIONAL distilled STYLE GUIDE prose (from a saved
    EffectStyle, packages/video/effects_style.py). When non-empty it is spliced
    into the prompt as the authoritative <style> section, demoting the generic
    density/restraint defaults; when empty, those defaults apply. This is the
    primary, reusable style path (analysed once, no video re-upload) — the
    per-run ``reference_path`` below is a lighter fallback for one-off use.

    ``cut_points_sec`` — OPTIONAL real scene-cut timestamps (seconds, in the
    already-merged output timeline) the caller knows from its own edit script/
    timeline. When given, the model may place a `transitions` whip-pan sweep
    AT one of these exact instants (see <transition> in the prompt); when
    omitted, `transitions` is always empty — the model has no cut boundaries
    to anchor one to.

    ``reference_path`` — an OPTIONAL video/image the user attached purely as
    style inspiration (see <reference> in the prompt); never the actual clip.

    ``image_asset_path`` — an OPTIONAL image the user wants placed IN the clip
    as a sticker/popup (see <image_asset> in the prompt). The model is told to
    place it via ``image-sticker``/``logo-reveal`` WITHOUT an ``imagePath``
    prop — it has no real path to give. Any ``catalogPlacements`` entry using
    one of those two componentIds gets its (necessarily fake) ``imagePath``
    stripped here, and — only when this param was actually provided — replaced
    with the sentinel ``"__PENDING_ASSET__"`` so the CALLER can substitute the
    real local file path afterward (the desktop client knows it; this server
    only ever saw an ephemeral upload for vision judgment, never a path useful
    at render time on the user's machine).

    Returns a normalized effects.json dict (``{"version", "instances"}``). The
    caller sets the UsageCtx before invoking (same pattern as the dub tasks).
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.files import delete_gemini_files, gemini_video_block, upload_gemini_file
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.effects_catalog import (
        THAI_FONT_GUIDE,
        catalog_prompt_text,
        known_component_ids,
        missing_required_content_key,
        normalize_props_for_component,
    )
    from packages.video.ffmpeg_bin import media_duration
    from packages.video.timeline import parse_llm_json

    settings = get_settings()
    model = f"gemini/{settings.effects_vision_model}"
    video_path = pathlib.Path(video_path)
    duration_sec = media_duration(video_path)
    ref_path = pathlib.Path(reference_path) if reference_path else None
    asset_path = pathlib.Path(image_asset_path) if image_asset_path else None

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
        asset_file_id: str | None = None
        asset_mime = ""
        if asset_path is not None:
            asset_mime = _guess_mime(asset_path, default="image/jpeg")
            asset_file_id = await upload_gemini_file(asset_path, mime_type=asset_mime)
            file_ids.append(asset_file_id)
        upload_ms = round((time.monotonic() - t_upload) * 1000)

        font_guide_block = "\n".join(f"- {fid}: {mood}" for fid, mood in THAI_FONT_GUIDE)
        style_block = (
            _STYLE_SECTION_PRESENT_TEMPLATE.replace("__STYLE_PROSE__", style_prompt.strip())
            if style_prompt.strip()
            else _STYLE_SECTION_ABSENT
        )
        system = (
            EFFECTS_PLACEMENT_SYSTEM
            .replace("__STYLE_BLOCK__", style_block)
            .replace("__CATALOG_BLOCK__", catalog_prompt_text())
            .replace("__FONT_GUIDE_BLOCK__", font_guide_block)
            .replace(
                "__REFERENCE_SECTION__",
                _REFERENCE_SECTION_PRESENT if ref_file_id else _REFERENCE_SECTION_ABSENT,
            )
            .replace(
                "__IMAGE_ASSET_SECTION__",
                _IMAGE_ASSET_SECTION_PRESENT if asset_file_id else _IMAGE_ASSET_SECTION_ABSENT,
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
            # "Different" means different CONTENT (colors, exact text, exact
            # timing/positions) — NOT a different technique category. Without
            # this guard the model reads "avoid repeating the previous
            # attempt" as license to drop zoomPunches/transitions/sceneDrifts
            # entirely just because the prior take used them, even when a
            # <style> (or the clip itself) genuinely calls for that technique
            # — observed live (2026-07-18): a style whose prose explicitly
            # asked for scene-drift got a fully static regenerate because the
            # rejected take "leaned heavily on scene-drift". The technique
            # choice must keep tracking <style>/<zoom>/<transition> guidance
            # every regenerate; only the specifics should vary.
            style_note = (
                " If a <style> section is given above, its guidance on "
                "WHETHER to use zoomPunches/transitions/sceneDrifts and how "
                "often still applies — do not drop or add that TECHNIQUE "
                "just because the previous attempt used or skipped it; only "
                "the specific colors/text/moments/timings need to differ."
                if style_prompt.strip()
                else ""
            )
            user_text = (
                "<previous_attempt>\n"
                f"{prev_json}\n"
                "</previous_attempt>\n"
                "The user REJECTED the arrangement in <previous_attempt> and asked to "
                "regenerate. Produce a CLEARLY DIFFERENT take on the SAME content "
                "decisions: different colors, different exact text/wording, "
                "different moments/timings. Do not repeat any instance verbatim "
                "from the previous attempt." + style_note + "\n\n"
            ) + user_text
        user_content: list[dict[str, Any]] = []
        if ref_file_id:
            user_content += [
                {"type": "text", "text": "=== style reference (NOT the actual clip) ==="},
                gemini_video_block(ref_file_id, mime_type=ref_mime),
            ]
        if asset_file_id:
            user_content += [
                {"type": "text", "text": "=== image asset (may be placed as a sticker/popup) ==="},
                gemini_video_block(asset_file_id, mime_type=asset_mime),
            ]
        user_content += [
            {"type": "text", "text": "=== cut video ==="},
            gemini_video_block(file_ids[0]),
            {"type": "text", "text": user_text},
        ]
        messages = [{"role": "user", "content": user_content}]

        # "high" not "medium": this call's failure mode is silently incomplete
        # propsJson (empty {} / half-filled), which degrades to generic
        # placeholder visuals instead of erroring — worth the extra reasoning
        # budget for reliability, observed empirically (medium regularly
        # skipped color/label props under the fuller style-matching prompt).
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

        # Catalog stage: the fast, trusted default path — validate + normalize
        # against effects_catalog.py exactly like a manually-placed instance
        # would be (unknown componentId or non-overlay kind is dropped, props
        # are renamed/clamped/truncated by normalize_props_for_component). No
        # codegen call, so this is effectively free — safe to have many.
        known_ids = known_component_ids()
        catalog_items = placement.get("catalogPlacements") or []
        if isinstance(catalog_items, list):
            from packages.video.effects import EffectInstance
            from packages.video.effects_catalog import component_catalog

            overlay_ids = {c["componentId"] for c in component_catalog() if c["kind"] == "overlay"}
            for k, item in enumerate(catalog_items):
                if not isinstance(item, dict):
                    continue
                component_id = str(item.get("componentId", ""))
                if component_id not in known_ids or component_id not in overlay_ids:
                    log.warning(
                        "effects_ai_catalog_unknown_id", project_uid=project_uid, component_id=component_id
                    )
                    continue
                raw_props = item.get("props") if isinstance(item.get("props"), dict) else {}
                props = normalize_props_for_component(component_id, raw_props)
                missing_key = missing_required_content_key(component_id, props)
                if missing_key:
                    # Observed live: the model picks the right component at the
                    # right time but ships `props: {}` (or just the content key
                    # empty) — that renders the component's bundled generic
                    # default (bland text, wrong place), which looks worse and
                    # more disconnected from the clip than not placing it at
                    # all. Drop rather than render a half-finished effect.
                    log.warning(
                        "effects_ai_catalog_missing_content",
                        project_uid=project_uid, component_id=component_id, missing_key=missing_key,
                    )
                    continue
                # image-sticker/logo-reveal: strip whatever fake imagePath the
                # model may have hallucinated despite the prompt telling it not
                # to; if a real asset was actually attached, mark a sentinel
                # the caller replaces with the true local file path.
                if component_id in ("image-sticker", "logo-reveal"):
                    props.pop("imagePath", None)
                    if asset_file_id:
                        props["imagePath"] = "__PENDING_ASSET__"
                    else:
                        continue  # nothing to show without a real asset
                start = max(0.0, min(float(item.get("startSec", 0) or 0), duration_sec - 0.1))
                dur = max(0.1, min(float(item.get("durationSec", 2.0) or 2.0), duration_sec - start))
                doc.instances.append(EffectInstance(
                    id=f"cat_ai_{k}",
                    kind="overlay",
                    componentId=component_id,
                    startSec=round(start, 2),
                    durationSec=round(dur, 2),
                    zOrder=k,
                    props=props,
                    source="ai",
                ))
            if catalog_items:
                log.info("effects_ai_catalog_ok", project_uid=project_uid, count=len(doc.instances))

        # Bespoke stage: turn each customEffects brief into a real generated
        # component via the codegen model. No cap — the placement model decides
        # freely how many bespoke effects this clip calls for, which can be a
        # dozen-plus on a busy clip, so the calls run CONCURRENTLY (one
        # sequential await per brief would make a 10-effect clip take minutes).
        # Best-effort per item: a failed generation never sinks the whole
        # placement, it's just dropped and the rest proceed.
        custom = placement.get("customEffects") or []
        if isinstance(custom, list) and custom:
            from packages.video.effects import EffectInstance
            from packages.video.effects_codegen import generate_effect_component

            valid_items = [
                item for item in custom
                if isinstance(item, dict) and str(item.get("brief", "")).strip()
            ]

            async def _gen_one(item: dict[str, Any]) -> str | None:
                try:
                    return await generate_effect_component(
                        str(item["brief"]), project_uid=project_uid
                    )
                except Exception as exc:  # noqa: BLE001 — per-item best effort
                    log.warning("effects_ai_custom_failed", project_uid=project_uid, error=str(exc))
                    return None

            sources = await asyncio.gather(*(_gen_one(item) for item in valid_items))
            for i, (item, source) in enumerate(zip(valid_items, sources, strict=True)):
                if source is None:
                    continue
                start = max(0.0, min(float(item.get("startSec", 0) or 0), duration_sec - 0.5))
                dur = max(0.5, min(float(item.get("durationSec", 2.5) or 2.5), duration_sec - start))
                doc.instances.append(EffectInstance(
                    id=f"gen_ai_{i}",
                    kind="overlay",
                    componentId="generated",
                    startSec=round(start, 2),
                    durationSec=round(dur, 2),
                    zOrder=100 + i,
                    props={},
                    source="ai",
                    componentSource=source,
                ))
                log.info("effects_ai_custom_ok", project_uid=project_uid, brief=str(item["brief"])[:80])

        # Zoom stage: pure numbers straight onto the real footage via the
        # existing ffmpeg punch-zoom transform — no codegen call, so the model
        # can call for as many focus-holds as the clip's content genuinely has.
        zooms = placement.get("zoomPunches") or []
        if isinstance(zooms, list):
            from packages.video.effects import EffectInstance

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
                is_cut_style = str(z.get("style")) != "push"
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
                ramp = _zoom_ramp_sec(z.get("style"), dur, z.get("rampSec"))
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
                        "zoomTo": min(4.0, max(1.0, float(z.get("zoomTo", 1.3) or 1.3))),
                        "focusX": focus_x,
                        "focusY": focus_y,
                        "rampSec": ramp,
                        # true → snap back instantly at the window's end
                        # (correct when that end IS a real cut — the shot
                        # actually changes there). false → ease back to
                        # normal before the window ends (a deliberate
                        # mid-scene release with no real cut underneath).
                        # See ends_on_real_cut above and punch_zoom_filter.
                        "hold": "true" if ends_on_real_cut else "false",
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
        # same no-codegen, pure-numbers reasoning as zoomPunches, but only
        # meaningful (and only requested by the prompt) when cut_points_sec
        # was actually provided; snapped to the nearest real cut so a
        # near-miss timestamp from the model still lands on the true boundary.
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
            from packages.video.effects import EffectInstance

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
                log.info("effects_ai_transitions_ok", project_uid=project_uid, count=len(doc.instances) and len(transitions))

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
            from packages.video.effects import EffectInstance

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
                zoom_to = max(1.0, min(1.6, float(sd.get("zoomTo", 1.15) or 1.15)))
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
                        "zoomFrom": 1.0,
                        "zoomTo": zoom_to,
                        "focusFromX": fx0,
                        "focusFromY": fy0,
                        "focusToX": fx1,
                        "focusToY": fy1,
                    },
                    source="ai",
                ))
            if scene_drifts:
                log.info("effects_ai_scene_drifts_ok", project_uid=project_uid, count=len(doc.instances))

        log.info("effects_ai_done", project_uid=project_uid, instances=len(doc.instances))
        return doc.model_dump()
    finally:
        await delete_gemini_files(file_ids)
