# AI-Assisted Effects Layer (Remotion) — Requirements (Draft)

Status: **not started — draft captured from planning conversation, no code written yet**.
This is a new post-processing stage layered on top of the existing AI video pipeline
(`packages/video/*`, both `talking_head` and `dub_first` modes, web + desktop app).
See `PROJECT_REQUIREMENTS.md`, `DESKTOP_VIDEO_APP_REQUIREMENTS.md`, and
`desktop/README.md` for the pipeline this stage builds on.

## 1. Problem / goal

After the AI cut/dub pipeline finishes (`final.mp4` / `final_silent.mp4` + voiceover),
the user wants to add motion-graphics polish on top: punch-zooms on products/faces,
stickers, popups, and other animated elements — styled to match the clip (or a user
prompt), placed automatically by AI, then hand-tunable.

Decision (from prior discussion in this session): build this on **Remotion**
(React-based programmatic video), as a **separate effects layer/track** rendered on
top of the already-cut video, not by modifying the cut/render pipeline itself.

## 2. Where this fits in the flow

1. Existing pipeline runs to completion (talking_head or dub_first) → user has a
   finished cut video (`final.mp4` or dub bundle).
2. User opts into a **separate "effects" step** — a new stage/session, distinct from
   the cut/dub AI session. Not automatic, not bundled into the original render job.
3. This stage has its own AI call (own `UsageCtx`, own prompt, via `packages/llm` —
   provider-agnostic, no reason it must be the same model as the cut/dub planning
   step).

## 3. AI responsibilities in the effects stage

- **Analyze the already-rendered clip** (vision pass over frames/segments, similar in
  spirit to the existing `style_profile.py` Vision approach) to understand what's in
  each segment — product shot, face/talking segment, text overlay moment, etc.
- **Decide which effects to place, where, and how**:
  - e.g. punch-zoom into a product, punch-zoom into a face, add a sticker, add a
    popup/callout, or other pre-built element types.
  - Effects are placed by **segment/time range**, not globally.
- **Adapt style to fit**: color, scale, minor style variants of a chosen
  element/component so it matches the clip's look — or matches an explicit user
  style instruction (see §4 templates / prompts). This is *parameter* adaptation
  (color, scale, timing, easing), not new-component code generation — see §6.
- Optional **user prompt before generation starts**: the user must be able to type
  free-text guidance (e.g. "zoom on the product more", "add playful stickers",
  "keep it minimal") that the AI factors into effect choice/placement/style **before**
  the first pass runs. This prompt step is a hard requirement, not a nice-to-have.

## 4. Templates (user-defined presets)

- User can save a chosen combination of effects/styles as a **template** ahead of
  time (a named preset: which components, what style/colors, roughly how they're
  used).
- User can later apply a saved template directly to a new clip as a shortcut —
  skips full AI improvisation on *which* elements/style to use (that's fixed by the
  template), but still runs a **lighter AI placement pass** to fit the template's
  elements onto the new clip's actual segments/timing (segment count/duration
  differs per clip, so placement can't be purely copy-paste). This reuses the same
  analysis step from §3, just with the element/style choice pre-constrained by the
  template instead of freely chosen.
- Templates and free-form AI-prompted generation are two entry points into the same
  underlying effect-placement data structure (see §9 open questions).

## 5. Manual edit after AI generation

Once the AI (or template) produces a first pass, the user must be able to hand-edit
the result — this is a **hard requirement**, not optional polish:

- **Move** an effect/component earlier or later in time (shift start position).
- **Stretch/shrink** an effect's own animation duration (e.g. how long the zoom
  transition takes).
- **Stretch/shrink** how long a component stays on screen (persistence/hold
  duration, independent of its intro/outro animation length).
- **Swap** the effect/component for a different one from the available set, at the
  same placement.
- **Delete** an effect instance.
- **Add** a new effect instance manually (pick component + place + set params),
  independent of what AI/template generated.
- **Adjust per-instance style params** directly (color, scale, etc.), not just
  timing.

This implies a **timeline editor UI for the effects layer**, analogous to the
existing cut/edit-script timeline editor (`TimelineEditor` in the desktop app /
`VideoTimelineEditor.tsx` on web) but operating on effect instances (component +
time range + params) rather than cut segments.

## 6. Architecture guardrails (decided earlier in this session — carry forward)

- **AI does not generate raw Remotion/TSX code at runtime.** It selects and
  composes from a **fixed registry of pre-built, parameterized Remotion
  components** (shape, text-reveal, punch-zoom, sticker frame, popup, etc.), output
  as **structured JSON** (component id + nested composition + prop values) via the
  existing `packages/llm` structured-output pattern (cf. `DUB_EDIT_SCHEMA_VIDEO`).
  Reason: running AI-authored code at runtime in a distributed desktop app is a
  security/sandboxing/reliability risk; constrained composition avoids it while
  still allowing novel-looking combinations.
- **Component library authoring is a separate, dev-time concern.** Building the
  Remotion component registry itself (the effect primitives, sticker components,
  their prop surfaces) is done by us during development (optionally AI-assisted via
  Claude Code + the official Remotion skill, since that tooling only needs to exist
  on the dev machine, not in the shipped app). This is not part of the runtime
  product surface and does not ship as an AI capability to end users.
- **User-uploaded stickers**: supported via Remotion's `<Img>` / `staticFile()` —
  any user-provided PNG/GIF becomes a sticker asset a component can render. No
  special Remotion feature needed for this beyond a normal file-upload flow.
- **Licensing**: Remotion core is source-available, not OSS (proprietary Remotion
  License) — free for individuals/small companies including commercial use, but a
  company license is required above a revenue/team-size threshold. Must be checked
  against actual usage before shipping, since this is a distributed commercial app.

## 7. User-created asset storage

Everything the user creates or customizes — templates, effect presets/instances,
popups, stickers (including uploaded images), subtitle styles, and any other element
— is saved **locally on the user's machine**, not synced to the backend/server. The
app reads from this local library to populate pickers and reuse saved items across
projects.

- Consistent with the desktop app's existing local-first storage pattern (project
  registry under `userData/projects/<uid>/project.json` — see
  `DESKTOP_VIDEO_APP_REQUIREMENTS.md` §5 / `desktop/README.md`). This asset library
  is a new, separate local store alongside that (e.g.
  `userData/effects-library/` or similar — exact layout TBD at implementation).
  Not project-scoped like `project.json` — user-created templates/stickers/etc. are
  reusable **across all of a user's projects**, so they live at the app-data level,
  not per-project.
- No server sync/backup for this library in scope here — if the user reinstalls or
  switches machines, this library does not follow them (open question below: is a
  future export/import or cloud-sync feature wanted, or is local-only permanent?).

## 7a. Default (bundled) assets

The user asset library (§7) is not empty on first run — the app ships with a
**default set of templates, effects, elements, stickers, and subtitle styles**
pre-installed on the user's machine as part of the install/first-run, not something
the user has to build from scratch. User-created items (§7) live alongside these
defaults in the same local library and are usable the same way (picker, reuse across
projects) — defaults are just pre-seeded entries, not a separate mechanism.

- Sourced from the component registry built during dev (§6 — the primitives we
  build, optionally Claude-Code-assisted) — the default library is a curated set of
  ready-made instances/presets built from that registry, not a different thing.
- Exact seeding mechanism TBD at implementation (bundled JSON + asset files in the
  installer vs. generated on first run) — functionally it must behave like the user
  already has a working starter set the moment they open the effects feature.

## 7b. User-facing documentation

Must ship user-facing docs/guide explaining **what this feature can do** — what
effects/elements/stickers/templates exist, what they look like, and how to use them
(prompt-driven generation, template picker, manual editing). This is end-user product
documentation (in-app help, README, or similar — format TBD), separate from the
internal engineering requirements in this file. Needed because the feature is
otherwise opaque: the user has no way to know what's possible (what "effects" means
concretely, what styles are available) without being shown.

## 8. Decisions (resolved 2026-07-15)

- **Manual edit scope**: full editor, not just move/stretch/swap. Also supports
  **delete**, **add new instance**, and **direct per-instance style param edits**
  (color, scale, etc.), not just timing.
- **Template placement on a new clip**: template fixes *which* elements/style to
  use; placement onto the new clip's actual segments/timing still runs a **lighter
  AI pass** (not pure rule-based %-of-clip math) — reuses the §3 analysis step with
  element/style choice pre-constrained.
- **Render location**: **desktop app, local** — consistent with the rest of the
  pipeline (privacy, no server round-trip for render). Accepted tradeoff: the
  desktop app must bundle a Chromium-based Remotion renderer alongside the existing
  PyInstaller sidecar + ffmpeg, which grows the installer and adds another
  cross-platform build target to sort out for the future macOS build.
- **Compositing strategy**: Remotion renders **only the effects layer** — a
  transparent-background overlay (image sequence or alpha video), never touching
  the full-length cut video. ffmpeg then composites that overlay on top of the
  already-cut video as a separate final step, reusing the existing ffmpeg pipeline.
  Rejected alternative: feeding the full cut video into Remotion as a background
  layer and rendering one final file — adds full-length video decode/handling cost
  inside Remotion for no benefit, and couples the effects renderer to the cut
  pipeline instead of keeping them as separate concerns.
- **AI model/provider for the analysis + placement pass**: **Gemini**, the model
  already configured in `packages/llm` for this project — no vendor switch needed,
  just extend the existing config/schema pattern for this new structured-output
  call.
- **Final output**: a single complete video file (composited `final.mp4`, effects
  burned in) — the primary deliverable users download/play, no manual reassembly
  required.
- **AI prompt**: a **new, dedicated system prompt** for this stage — not reused from
  the cut/dub planning prompts, since the task (analyze an already-cut clip, choose
  from the effects component registry, output effect-placement JSON) is a distinct
  job with its own schema (e.g. an `EFFECTS_PLACEMENT_SCHEMA` alongside the existing
  `DUB_EDIT_SCHEMA_VIDEO`).
- **CapCut bundle export for effects**: extends the existing bundle pattern
  (`render_common.py build_capcut_bundle` — clips/captions/stickers already exported
  separately with timing in `manifest.json`). Each **effect instance** additionally
  exports as its own transparent-background file (alpha video/webm or PNG sequence,
  whichever CapCut import supports better — needs a spike) plus a timing/position
  entry in `manifest.json`, alongside the existing composited `final.mp4` (which
  stays in the bundle as the ready-to-use reference/output). This mirrors how
  today's static stickers are already exported individually for CapCut re-import —
  animated effects get the same treatment, just as video/sequence assets instead of
  static PNGs.
- **User-created asset storage**: local-only, on the user's machine, reusable across
  projects (see §7).

## 9. Open questions (unresolved — decide in a future session)

- Data model for an "effect instance": component id, time range (start/duration),
  z-order/track, prop bag (style overrides), source (AI-generated vs template vs
  manual). Needs a schema, likely a new JSON file alongside `timeline.json` /
  `edit_script.json` (e.g. `effects.json`) rather than overloading the existing cut
  timeline formats.
- Exact local storage layout for the user asset library (§7) — folder structure,
  naming, how it's referenced from `effects.json`.
- Exact contents/scope of the default bundled set (§7a) — how many templates,
  which effect types, sticker packs — and the seeding mechanism (bundled at build
  vs. generated first-run).
- Format/location of the user-facing docs (§7b) — in-app help panel, a bundled
  README, a web page, or a combination.
- Whether the user asset library ever gets export/import or cloud-sync (moving
  between machines) — out of scope for now, local-only, but flagged as a likely
  future ask.
- CapCut-compatible format for animated effect assets — alpha video/webm vs PNG
  sequence — needs a spike against actual CapCut import behavior before committing.
