"""AI-generated effect components (REMOTION_EFFECTS_REQUIREMENTS.md §6
extension, decided 2026-07-16; became the ONLY overlay-generation path for the
AI placement pass on 2026-07-17 — see effects.py's EFFECTS_PLACEMENT_SCHEMA
docstring for why the old fixed-catalog matching was removed outright).

This module lets the user (or the placement pass) ask for a new overlay
component, described by a text prompt and/or a reference image. The model
writes a plain JS+JSX Remotion component; nothing about that source is
trusted based on this call succeeding.

ALLOWED IMPORTS (mirrored in node-sidecar/src/codegenValidate.mjs
ALLOWED_IMPORT_SOURCES — keep both lists in sync): react, remotion,
lucide-react, @remotion/shapes, @remotion/lottie, @remotion/light-leaks,
@remotion/layout-utils, @remotion/paths, @remotion/starburst,
@remotion/noise, @remotion/animation-utils, @remotion/motion-blur,
@remotion/rounded-text-box, @remotion/effects (+ its per-effect subpaths, e.g.
@remotion/effects/glow — subpath names are taken from the INSTALLED package's
dist/*.d.ts, never from docs/memory).

@remotion/effects works on clean machines: Remotion ships a Chrome build with
the required `canvas-draw-element` flag pre-enabled (v4.0.455+), the packaged
app already stages that headless shell (app/scripts/prepare-resources.mjs →
REMOTION_BROWSER_EXECUTABLE), and render.mjs/codegen.mjs pass
chromiumOptions:{gl:'angle'} for the shaders. Generated code MUST route it
through the isHtmlInCanvasSupported() guard (compositions/FxCanvas.tsx shows
the pattern) so the desktop app's live <Player> preview — older Chromium,
flag off — degrades to plain children instead of erroring.

Deliberately NOT included: framer-motion / motion (CSS-transition animation —
wrong under Remotion's frame-by-frame renderer), @remotion/animated-emoji
(asset paths in generated code are fragile; it ships as a trusted registry
component instead).

SECURITY MODEL — read before touching this file:
The output of this call is UNTRUSTED input, no different in kind from user-
uploaded content, even though it looks like source code. A prompt instruction
telling the model "don't access the filesystem" is NOT a security boundary — the
same call that produces this code also processes user-controlled content
(the reference image, the free-text prompt) that could carry an injected
instruction trying to override those rules, the same way any prompt injection
attack works. The prompt below states the rules anyway (cheap, reduces wasted
generations that fail validation) but the REAL enforcement is entirely on the
desktop side: desktop/node-sidecar/src/codegenValidate.mjs statically parses
the returned source and rejects anything outside a hard allowlist BEFORE it is
ever bundled or executed. `_looks_safe()` below is a fast, best-effort,
NON-AUTHORITATIVE pre-filter — it exists only to fail fast and save a wasted
render round-trip; it must never be treated as the actual gate.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any

GENERATED_COMPONENT_SYSTEM = """<role>
You write ONE small Remotion (React video) overlay component in plain
JavaScript + JSX — no TypeScript syntax, no type annotations. Do all reasoning
in English. On-screen text you author should be in Thai (Thai affiliate
content) unless the user's prompt says otherwise.

This is a SERVER-SIDE VIDEO RENDERING ENVIRONMENT, not a web app. Packages
that exist here: React, Remotion (`remotion` + official `@remotion/*`
sub-packages), and `lucide-react` (icon components as plain SVGs — fine for
frame-by-frame render). There is NO npm registry access at render time for
anything else — no standalone animation libraries, no other icon packs, no
UI kits. In particular framer-motion / motion / AnimatePresence MUST NOT be
used: they rely on CSS transitions and browser time, which do NOT render
correctly in Remotion's frame-by-frame renderer (every animated value must
be a pure function of `useCurrentFrame()` via `interpolate`/`spring`).
Also forbidden by habit: react-icons, @radix-ui, shadcn, tailwind,
styled-components, axios — none of those are installed. Prefer `lucide-react`
for icons; otherwise draw with inline SVG / `@remotion/shapes` /
`@remotion/paths`.
</role>

<output_contract>
Return ONLY the source code, nothing else — no markdown fences, no prose before
or after. The source MUST:
- Import ONLY from: "react", "remotion", "lucide-react", "@remotion/shapes",
  "@remotion/lottie", "@remotion/light-leaks", "@remotion/layout-utils",
  "@remotion/paths", "@remotion/starburst", "@remotion/noise",
  "@remotion/animation-utils", "@remotion/motion-blur",
  "@remotion/rounded-text-box", "@remotion/effects/<name>" — see
  <extended_capabilities> below for what each offers. No other import is
  allowed and will be rejected. When in doubt for non-icon needs, don't
  import; build it from what's here.
- `export const GeneratedEffect = (props) => { ... }` — the component, taking
  a single props object (destructure whatever fields you need).
- Optionally `export const generatedEffectDefaultProps = { ... }` — sensible
  defaults for every prop you use.
- Never touch the filesystem, network, environment, or any Node/browser global
  (no fs, child_process, process, fetch, XMLHttpRequest, eval, Function,
  require, __dirname, global, globalThis). Anything like this is rejected
  before it ever runs — don't include it even experimentally.
- Paint NOTHING full-frame opaque — this is a TRANSPARENT overlay composited
  on top of a video by ffmpeg afterwards. No background-color on the root
  element/AbsoluteFill.
- Use `useCurrentFrame()` + `interpolate()`/`spring()` for animation, matching
  Remotion's own composition conventions (prefer `interpolate()` for most
  animation, `spring()` for spring-like physics; use the `scale`/`translate`/
  `rotate` CSS shorthand properties, not a combined `transform` string).
- CSS `transition`/`animation`/`@keyframes` and any animation class names are
  FORBIDDEN — they do not render correctly frame-by-frame. Every animated value
  must be a pure function of `useCurrentFrame()`. Never import framer-motion,
  motion, or AnimatePresence.
</output_contract>

<motion_quality>
This must look like professional TikTok motion graphics, not a programmer demo.
The single biggest tell of amateur work is LINEAR motion — never animate with a
bare `interpolate()` ramp when the element enters, exits, or emphasizes.

- Give every `interpolate()` an `easing` (import `Easing` from "remotion") plus
  `extrapolateLeft: "clamp", extrapolateRight: "clamp"`.
- CRITICAL — `inputRange` (2nd argument) MUST be strictly increasing numbers,
  e.g. `[0, 20]` or `[exitStart, durationInFrames]`. NEVER pass a decreasing
  range like `[1, 0]` or `[exitEnd, exitStart]` as inputRange — Remotion throws
  `inputRange must be strictly monotonically increasing` and the render dies.
  Fade-outs / reverse motion go in the OUTPUT range: use
  `interpolate(frame, [exitStart, durationInFrames], [1, 0], …)` (input up,
  output down). Before calling interpolate, ensure
  `exitStart = Math.max(0, durationInFrames - N)` and `exitStart < durationInFrames`
  (if the clip is shorter than N frames, skip the exit animation or use
  `[0, Math.max(1, durationInFrames)]` instead of an inverted pair).
- Entrances: fast-out expo-style curve with slight settle —
  `Easing.bezier(0.16, 1, 0.3, 1)` is a great default. Springy pop-ins: use
  `spring({ frame, fps, config: { damping: 12 } })` for visible overshoot, or
  `damping: 200` for smooth no-bounce.
- Exits should be quicker than entrances (roughly half the duration) and ease IN
  (`Easing.bezier(0.7, 0, 0.84, 0)`), not mirror the entrance.
- Choreograph: when several parts appear, stagger them a few frames apart
  instead of all at once. Combine at least two properties per movement (e.g.
  opacity + translate, or scale + rotate) — single-property fades look cheap.
- Add subtle life during the hold (a gentle float, pulse, or rotation drift a
  few px/deg), so the element never sits frozen on screen.

Worked example — the shape and quality bar to imitate (a pill that pops in with
overshoot, floats gently, and exits early and fast):

const frame = useCurrentFrame();
const { fps, width, height, durationInFrames } = useVideoConfig();
const enter = spring({ frame, fps, config: { damping: 12 } });
const exitSpan = Math.max(1, Math.round(fps * 0.25));
const exitStart = Math.max(0, durationInFrames - exitSpan);
const exit = interpolate(frame, [exitStart, Math.max(exitStart + 1, durationInFrames)], [1, 0], {
  easing: Easing.bezier(0.7, 0, 0.84, 0),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
const floatY = Math.sin(frame / 14) * 6;
// style={{ opacity: exit, scale: String(enter),
//          translate: `0px ${(1 - enter) * 24 + floatY}px` }}
</motion_quality>

<extended_capabilities>
Real Remotion packages beyond the basics — reach for these instead of
reinventing them or (worse) reaching for an outside library:

- `@remotion/rounded-text-box` — the ACTUAL TikTok-style rounded pill/box
  generator, not a hand-rolled `borderRadius` div. Pairs with `measureText`:
    import { measureText } from "@remotion/layout-utils";
    import { createRoundedTextBox } from "@remotion/rounded-text-box";
    const line = measureText({ text, fontFamily: "sans-serif", fontSize, fontWeight: "800" });
    const { d, boundingBox } = createRoundedTextBox({
      textMeasurements: [line], textAlign: "center",
      horizontalPadding: fontSize * 0.6, borderRadius: fontSize * 0.5,
    });
    // <svg width={boundingBox.width} height={boundingBox.height}>
    //   <path d={d} fill={bg} />
    // </svg>  — then the text itself absolutely-positioned on top, centered
    // in the same boundingBox.
  Reach for this any time a brief wants a badge/pill/label — it is strictly
  better than a plain `borderRadius` rectangle.
- `@remotion/starburst` — a ray/burst component for a "shine"/attention pop:
    import { Starburst } from "@remotion/starburst";
    <Starburst rays={16} colors={["#FFD400", "#FF8A00"]} rotation={frame * 2}
               smoothness={0.4} vignette={0.2} />
  Good behind a badge or at a reveal moment — not on every effect.
- `@remotion/noise` — pure `noise2D(seed, x, y) -> number` (also 3D/4D)
  for ORGANIC drift instead of a plain `Math.sin` wobble — visibly less
  mechanical for idle float/jitter:
    import { noise2D } from "@remotion/noise";
    const driftY = noise2D("float-seed", frame / 30, 0) * 8;
- `@remotion/animation-utils` — `interpolateStyles` animates MULTIPLE CSS
  properties (including colors) across the same keyframes in one call instead
  of separate `interpolate()` calls per property:
    import { interpolateStyles } from "@remotion/animation-utils";
    const style = interpolateStyles(frame, [0, 15], [
      { opacity: 0, backgroundColor: "#FF2D55" },
      { opacity: 1, backgroundColor: "#FFD400" },
    ], { easing: Easing.bezier(0.16, 1, 0.3, 1) });
  Also exports transform-string builders (`translate`, `rotate`, `scale`,
  `skew`, …) if you need to compose a `transform` string directly instead of
  the scale/translate/rotate CSS shorthand.
- `@remotion/effects` — REAL shader effects (glow, drop-shadow, chromatic
  aberration, pixelate, scanlines, zoom-blur, halftone, thermal-vision,
  tv-signal-off, waves, shine, …). Import per-effect subpath, e.g.
  `import { glow } from "@remotion/effects/glow"`. They apply through
  `<HtmlInCanvas>`, which does NOT exist in the editor's live preview — so
  ALWAYS write the guard below verbatim, or the preview breaks:

    import { HtmlInCanvas, isHtmlInCanvasSupported, useVideoConfig } from "remotion";
    import { glow } from "@remotion/effects/glow";
    const { width, height } = useVideoConfig();
    const inner = (<div style={{ /* your normal transparent overlay JSX */ }} />);
    return isHtmlInCanvasSupported()
      ? (<HtmlInCanvas width={width} height={height}
           effects={[glow({ radius: 24, intensity: 1.4, threshold: 0.35, color: "#00d8ff" })]}>
           {inner}
         </HtmlInCanvas>)
      : inner;

  Params are per-effect — glow: {radius,intensity,threshold,color};
  drop-shadow: {radius,offsetX,offsetY,opacity,color}. Use effects for what CSS
  genuinely cannot do (true luminance-thresholded bloom, chromatic split,
  shader distortion); a plain `textShadow`/`filter: drop-shadow()` is cheaper
  and previews live — prefer it for ordinary glows/shadows.
- `@remotion/motion-blur` — `<Trail layers={4} lagInFrames={2} trailOpacity={0.4}>`
  leaves a ghosting trail behind fast-moving children (great for a punchy
  swipe/dash); `<CameraMotionBlur shutterAngle={180}>` blurs based on motion
  speed. Both are plain wrapper components around your existing JSX.
</extended_capabilities>

<sizing>
The composition canvas size is NOT fixed — read it from remotion's
`useVideoConfig()` (`width`, `height`) and position elements as fractions of
that, the same convention the built-in registry components use (props named
`x`/`y` as 0..1 fractions is a good default unless the brief calls for
something else).
</sizing>

<visual_treatment>
A flat solid-color rectangle/pill with plain bold text is the single most
common amateur tell — do not default to it. Build actual depth and material,
the way real motion-graphics libraries do (remotion-scenes, remocn, and
Remotion's own "Aurora Glassmorphism" showcase all lean on these, never flat
fill alone):
- GRADIENT, not flat fill: a `linear-gradient(...)` or `radial-gradient(...)`
  background (2-3 stops) reads as designed; a single flat hex fill reads as a
  placeholder. Pick stops that relate to the brief's color, not just one hex
  repeated.
- GLOW/DEPTH via layered shadow: stack 2-3 `boxShadow` layers (or `filter:
  "drop-shadow(...)"` for non-rect shapes) at increasing blur/spread for a
  soft glow, instead of one flat `boxShadow`. E.g. a colored ambient glow
  behind the shape plus a tight dark contact shadow reads as premium; either
  alone reads flat.
- GLASS, when the brief calls for a subtle/premium tone: semi-transparent
  background color (alpha ~0.15-0.3) + `backdropFilter: "blur(Npx)"` + a thin
  ~1px semi-transparent white border reads as frosted glass. Chromium (which
  renders this) supports `backdropFilter` fully.
- Reserve pure flat fill for when the brief explicitly wants bold/blocky (e.g.
  a loud sale tag) — even then, add the shadow layering above so it doesn't
  sit dead flat on the frame.
</visual_treatment>

<typography>
If the brief involves on-screen TEXT, both of these are mandatory — text with
neither looks amateur and is often unreadable over busy video:
- LEGIBILITY: every piece of text needs a dark outline/stroke (CSS
  `WebkitTextStroke: "Npx rgba(0,0,0,0.4-0.6)"`, N scaled to font size, e.g.
  ~2% of fontSize) AND/OR a layered drop shadow (`textShadow`, 2-3 layers at
  increasing blur/offset) behind the fill color. Never render flat text with
  nothing behind it — it disappears against light or busy footage. The fill
  color follows whatever the brief specifies; the stroke/shadow is separate
  and near-black/near-white regardless, purely for contrast.
- REVEAL TECHNIQUE: pick whichever of these two fits the brief's tone (the
  brief may specify one explicitly — follow it; otherwise choose):
  - Staggered pop-in — each word (or the whole phrase for a short one) springs
    up with overshoot a few frames apart (see <motion_quality>). Energetic,
    bouncy, good for hype/promo copy.
  - Typewriter / character reveal — characters appear left-to-right in step
    with `useCurrentFrame()`, e.g. render `text.slice(0, interpolate(frame,
    [0, revealFrames], [0, text.length], { extrapolateRight: "clamp" }))`, a
    couple characters per frame at 30fps feels right (tune `revealFrames`
    accordingly — roughly `text.length / 2` frames total is a good default).
    Optionally pair with a blinking cursor (a thin rect toggling opacity every
    ~15 frames) at the current reveal position. Editorial, precise, good for
    captions/quotes/instructions rather than hype copy.
- NEVER OVERFLOW THE FRAME: a fixed `fontSize` on a string you didn't measure
  WILL eventually run past the frame edge — this has happened before and is
  not acceptable. `@remotion/layout-utils`'s `measureText` gives you the
  REAL rendered width; use it to shrink-to-fit before rendering, e.g.:

  import { measureText } from "@remotion/layout-utils";
  const { width, height } = useVideoConfig();
  const maxWidth = width * 0.86; // safe-area width
  let fontSize = 84; // your starting size
  while (
    measureText({ text, fontFamily: "sans-serif", fontSize, fontWeight: "800" }).width > maxWidth
    && fontSize > 32
  ) {
    fontSize -= 4;
  }
  // now render the text/pill/badge at this `fontSize` — it is guaranteed to
  // fit `maxWidth`. Do this for every string prop, not just the longest one
  // you imagine — the brief's actual text is what gets measured.
</typography>
"""


def _build_user_text(prompt: str, has_reference_image: bool) -> str:
    prompt_block = prompt.strip() or "(no specific instruction — use good judgment for a TikTok-style effect)"
    ref_note = (
        "\n\nA reference image is attached — take visual inspiration from its style/"
        "colors/mood, but still only compose from the allowed imports above; do not "
        "attempt to literally embed or fetch the reference image itself."
        if has_reference_image
        else ""
    )
    return f"<request>{prompt_block}</request>{ref_note}\n\nReturn ONLY the component source code."


# Fast, NON-AUTHORITATIVE pre-filter — see module docstring. The real gate is
# desktop/node-sidecar/src/codegenValidate.mjs (a real AST parse). This is a
# best-effort regex pass purely to avoid a wasted render round-trip when the
# model obviously ignored the rules; it is deliberately conservative (may
# reject some things a full parse would allow) since false negatives here are
# harmless — the desktop-side gate would catch them anyway.
_FORBIDDEN_PATTERNS = [
    r"\brequire\s*\(",
    r"\beval\s*\(",
    r"\bnew\s+Function\s*\(",
    r"\bfetch\s*\(",
    r"\bXMLHttpRequest\b",
    r"\bprocess\.",
    r"\b__dirname\b",
    r"\b__filename\b",
    r"\bglobalThis\b",
    # Exact package names only (not prefix): react-icons must NOT slip through
    # as a match for "react". Keep in sync with codegenValidate.mjs.
    r"^\s*import\s+.*from\s+['\"](?!(?:react|remotion|lucide-react)['\"]|@remotion/(?:shapes|lottie|light-leaks|layout-utils|paths|starburst|noise|animation-utils|motion-blur|rounded-text-box)['\"]|@remotion/effects(?:/[a-z-]+)?['\"])",
]


def _looks_safe(source: str) -> bool:
    for pattern in _FORBIDDEN_PATTERNS:
        if re.search(pattern, source, re.MULTILINE):
            return False
    return "GeneratedEffect" in source


async def generate_effect_component(
    prompt: str,
    *,
    reference_image_path: str | Path | None = None,
    project_uid: str,
) -> str:
    """Ask the model for a new Remotion overlay component's source.

    Returns the raw (untrusted) source text. Caller MUST pass it through the
    desktop-side validator before ever bundling/rendering it — this function
    only does a cheap non-authoritative pre-check to avoid wasting a whole
    generate+bundle+render round trip on an obviously-bad response.
    """
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.gateway import acompletion

    settings = get_settings()

    content: list[dict[str, Any]] = []
    if reference_image_path:
        b64 = base64.b64encode(Path(reference_image_path).read_bytes()).decode("ascii")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    content.append({
        "type": "text",
        "text": _build_user_text(prompt, has_reference_image=bool(reference_image_path)),
    })

    extra = call_kwargs(model=settings.effects_codegen_model, effort="medium")
    extra["timeout"] = settings.effects_codegen_timeout_sec

    resp = await acompletion(
        [{"role": "user", "content": content}],
        system=GENERATED_COMPONENT_SYSTEM,
        **extra,
    )
    source = (resp.choices[0].message.content or "").strip()
    # Strip a markdown fence if the model added one despite the instruction not to.
    source = re.sub(
        r"^```(?:jsx?|tsx?|html|javascript|typescript)?\s*\n?|\n?```\s*$",
        "",
        source,
        flags=re.IGNORECASE,
    ).strip()

    if not _looks_safe(source):
        why = (
            "missing export const GeneratedEffect"
            if "GeneratedEffect" not in source
            else "forbidden import or API (require/eval/fetch/…)"
        )
        raise ValueError(
            f"generated component failed the pre-check ({why}) — try a different prompt"
        )

    return source
