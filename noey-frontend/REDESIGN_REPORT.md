# Site redesign report — "The Cutting Room"

Branch `redesign/cutting-room` (not pushed, not merged). Every change to
visitor-facing words is in [CONTENT_CHANGES.md](CONTENT_CHANGES.md).

## Routes and their signature moment

Every route is built from the same shared parts (`src/components/ds/`,
`src/styles/components.css`): PageHero, SectionHeader, ClipCard, TimelineToc,
StatusCard, EditorMockup, ScrollTimeline, SpliceDivider, CtaBand, FaqList.

| Route | Signature |
| --- | --- |
| Global shell | Frosted header that shrinks on scroll with the Scroll Timeline under it (reading progress, section marks, a running timecode); the mobile menu is a full-screen sheet whose links arrive in a stagger; the splice page transition (View Transitions, a fade elsewhere, none with reduced motion); "end credits" footer on a night scene with the splice mark as a watermark; film grain and vignette |
| `/` | The hero editor tells the real pipeline in four beats — the create wizard's file step, its outcome step and review, the job progress page, the timeline with the cut playing — pinned to the scroll on a desktop, on a timer on phones; the playing editor can be scrubbed, picked and played with the keyboard. Behind it a light R3F scene of film frames (desktop only, after idle). USP tracks, a sticky problem split with a running timecode, a bento of features with six micro-demos, the three steps as a scroll-scrubbed strip, fit and misfit as two equal tracks, the fade-to-black closing scene |
| `/scope` | The handoff timeline: the system's three steps, the diagonal cut where the draft changes hands, then your work — played past a fixed playhead; fit and misfit as two parallel tracks |
| `/pricing` | The plan rail with the clips-per-month picker (it highlights the plan that fits, from `plans.ts` only, with `CLIPS_FOOTNOTE`), prices that count up, level-meter quota bars that fill on arrival, a comparison table that holds its header and first column and works on a phone |
| `/guide` | The media bin: each guide is a clip whose thumbnail is drawn from the guide itself (a cue per section, a waveform, its file name and length); hovering scrubs it |
| `/guide/*` (6) | The table of contents as a vertical timeline with a cue per heading and a playhead at your reading position; one polished article layout for all six (callouts, steps, term lists, tables) |
| `/about` | The story as chapters with timecodes on a rail that fills as you read, the five principles as locked tracks, the contact form held beside the story on a desktop |
| `/signup`, `/login` | Split screen: a still, plain form beside a viewer panel with the editor playing slowly; phones get the form alone, with the computer-only note |
| `/reset-password`, `/verify-email` | One status card for every state, with the splice mark and a render bar that is full (done), cut (failed) or running (waiting) |
| `/account` (+ quota, billing, profile) | The account as one editor panel: panel tabs along its edge, the editor card as the page's hero with "เปิดห้องตัดต่อ" the strongest button, quota bars as audio level meters that fill on load |
| `/checkout/success` | "Render complete": the render bar fills and the tick lands after it — no confetti |
| `/account-deleted` | The quiet status card: calm, plain, one way back |
| `/terms`, `/privacy` | The guides' reading layout and timeline table of contents with the least motion on the site |
| 404 | A timeline with one clip missing; the playhead runs up and drops into the gap |
| `global-error` | The same status card in the accent colour over a render bar cut in two |
| Social cards (`opengraph-image`) | The timeline motif in the site's colours and fonts |

## Lighthouse (mobile, production build)

LIGHTHOUSE_TABLE

## Independent review scores

REVIEW_TABLE

## Dependencies added

In the site (`noey-frontend/package.json`):

- `three` ^0.182.0 and `@react-three/fiber` ^9.8.1 — the hero's film-frame
  scene only. Loaded with `dynamic(..., { ssr: false })` after idle, on
  desktops that pass the device check; phones, low-power devices, Save-Data
  and reduced motion keep the static backdrop. DPR capped at 1.5; it stops
  rendering off screen and in a hidden tab.
- `@types/three` (dev).

Nothing else: no motion/GSAP/Lenis — the scroll, reveal and pinning runtime
is one small client component (`shell/MotionRuntime.tsx`) over CSS.

Offline tools, not part of the site build:

- `scripts/render-footage/package.json` (its own package): `three` ^0.185,
  `three-gpu-pathtracer`, `three-mesh-bvh`, `xatlas-web`, `vite` — the footage
  renderer.
- `scripts/render-footage/denoise.py`: OpenCV and NumPy.
- `scripts/thai-glossary.mjs` and `scripts/thai-breaks.mjs`: a Python with
  PyThaiNLP (the backend's virtualenv has it).
- The Playwright and Lighthouse checks import the tools from a path given in
  the environment (`PLAYWRIGHT_MODULE`); neither is a dependency of the site.

## Mock-ups of the app and their footage (MOCKUP_FIX_PROMPT.md)

### What the pictures are now

Every picture of the app on the site is a drawing of the real web editor
(`web/src`), made from its own markup and Tailwind class names, not a
screenshot and not an invented UI:

| Where | What it shows |
| --- | --- |
| Home hero (4 beats, pinned scroll; a timer on phones) | the create wizard's file step → its outcome step and review → the job progress page → the timeline editor with the cut playing |
| Home, three steps (`StepMockup`) | the same screens at rest |
| Home, six feature strips (`MicroDemos`) | the caption lane, the music lane and its volume, a scene being trimmed, a scene swapped for a backup shot, clips converted on the server, the export row being ticked |
| Home, three feature cards (`FeatureVisual`) | the timeline block, the project page's script panel, the whole editor in a browser tab |
| /pricing | the settings page's quota card with sample numbers |
| /signup, /login | the editor, playing |
| The six guides (hero) | the part of the editor each is about: the timeline, the caption lane, a shot swap, a trim, the whole editor, the quota card |

Owner decisions (2026-10-01) that shape them:

- They are drawn in the **site's** palette and follow its light/dark theme;
  layout, panel order, proportions and words are the app's.
- Only what makes a good picture is drawn. Everything drawn exists in the
  real editor and sits where the editor puts it: the parts left out keep
  their place unpainted (`Omit` in `app/ui.tsx`), so nothing else moves.
  Left out: header undo/redo, save status and shortcuts; the preview
  transport (the editor fades it while playing); the inspector's delete and
  its angles row; five toolbar controls and the px/วิ readout; the hint line;
  the wizard's helper sentences, cancel/back and "แก้" links; step 1's heading
  (it names the source clips with a word the site does not use).
- Customers use the web editor on a computer only (no desktop app, no
  phones), so the pictures follow the web build — e.g. the project page hands
  the script over with "คัดลอก" instead of recording (the web hides the
  recorder). The site copy was corrected to match (CONTENT_CHANGES.md §12–13).

How it is built:

- `scripts/app-mock-css.mjs` compiles the class names used by the mock-ups
  with the editor's own Tailwind and theme (read-only from `web/`), scopes them
  under `.am`, turns rem into px, viewport units and breakpoints into
  container units and container queries on the drawing's own "window", and
  maps the editor's colours to site tokens → `src/components/mockups/app/app.css`
  (29 KB). `scripts/extract-app-icons.mjs` copies the Lucide icons it needs.
- A window is laid out at the app's real size (e.g. 1024×768) and scaled to
  its box (`.am-view` / `.am`), so it lays out like a real browser window at
  any page width, always whole (scaled down, never cropped, on a phone).
- The pictures render through one client boundary (`mockups/client.ts`), so
  their markup is not repeated in the page's RSC payload, and a window away
  from the screen is skipped by `content-visibility: auto` until it comes
  near (about a third less main-thread work on the home page's load).
- The hero's choreography is CSS (`app/hero.css`); a beat that is left keeps
  its frame while it fades (`data-leaving` from `MotionRuntime`), so no other
  screen flashes in between.

### Interaction (§2.4)

`app/EditorLive.tsx` plays the cut in the editor's preview and lets a visitor
use the timeline in the hero's editor beat and the third step:

- drag or click the ruler and lanes to scrub — the footage seeks, the caption
  and the scene under the playhead follow, the inspector shows that scene;
  letting go plays on;
- click or Tab to a scene to select it (gold border and trim bars, as in the
  app) and jump to its start; ←/→ (Shift for 2 s), Home and End on the
  playhead slider, which is named "หัวเล่น" with the time as its value. A
  scene's target covers its picture and voiceover lanes (at least 24px tall
  on screen); on a window drawn under 400px wide (a phone) the scenes are not
  separate targets and the whole timeline is the slider;
- hover or focus a lane name or the preview for a note in the site's own
  words ("แก้ทับได้ทุกช็อต", "พากย์เสียง พร้อมสคริปต์จาก AI", "ใส่เพลงประกอบ",
  "ซับไทยอัตโนมัติ", "AI ตัดคลิปให้อัตโนมัติ");
- touch: a tap selects or seeks, a sideways drag scrubs, a vertical swipe
  still scrolls; on phones the hero stays on the editor while it is in use.

The layer is `inert` until its beat shows (and without JavaScript), so
nothing looks usable that is not. With reduced motion the hero rests on the
editor and scrubbing swaps the scene stills; there is no video.

### The footage

Rendered offline, never shipped as 3D: `scripts/render-footage/`.

1. `render.mjs` — three.js r185 + three-gpu-pathtracer in Chrome through
   Playwright (ANGLE's OpenGL backend: Metal mis-refracts). Five shots, 84
   frames each at 24 fps, 540×960, 96 samples a pixel (12–25 s a frame on
   this Mac; a fresh browser per shot; resumable):
   - `pedestal` — the bottle on a travertine plinth, a slow dolly in;
   - `texture` — close on the label, rising to the gold collar (macro);
   - `turntable` — the bottle turning, the label coming round;
   - `flatlay` — the bottle on linen in front of its carton, a slow push in;
   - `rack` — focus pulled from a dish of serum in the foreground to the
     bottle (f/3.2, a one-second pull).
   Glass, amber serum, brushed gold collar and soft-touch bulb are physical
   materials; linen, oak, travertine and the carton's printed board are
   textures generated in code (`textures.js`, no downloaded assets). The
   label and carton read only "FACE SERUM / Serum / 30 ml · 1 fl oz" — no
   brand.
2. `denoise.py` — the path tracer's grain removed without blurring the label:
   each frame's ±6 neighbours are aligned onto it with dense optical flow
   (OpenCV DIS, on blurred copies) and averaged, keeping the samples nearest
   their median (fireflies drop out), then a light non-local-means pass.
3. `encode.mjs` — the eight-scene cut the mock-ups' lanes are laid out from
   (`src/components/mockups/footage.json`), graded (light sharpening, lens
   vignette, a little temporal smoothing), a keyframe every half second for
   scrubbing; scene stills and three backup-shot stills as AVIF + WebP; one
   filmstrip sprite (54×96 tiles). File URLs carry a content hash
   (`footage-version.json`) and are served as immutable.

Realism review (MOCKUP_FIX_PROMPT.md part 3, independent reviewer): the first
render failed (grain, plastic look). The second passed the pedestal,
turntable and sharp rack-focus shots but failed the serum-drops macro (flat
smears) and the flat-lay (liquid in a lying bottle, hard box reflections,
dough-like pebbles) — those two shots were replaced by the label/collar
macro and the bottle-with-carton shot, and the rack focus got a gentler,
quicker pull. FOOTAGE_REVIEW_RESULT

Files in `public/footage/`: FOOTAGE_SIZES

Performance rules: no video loads until its mock-up is near the screen
(`preload="none"`, sources added on demand); it plays only on screen, with its
beat showing and the tab visible; one at a time on a phone, two on a desktop;
reduced motion, Save-Data or a low-power device get the stills; nothing is in
the critical path (the hero's H1 stays the LCP).

To rebuild: `node render.mjs --out FRAMES --w 540 --h 960 --spp 96 --fps 24`
(with `PLAYWRIGHT_MODULE` set), then
`python denoise.py --frames FRAMES --out CLEAN` (OpenCV + NumPy), then
`node encode.mjs --frames CLEAN`.
