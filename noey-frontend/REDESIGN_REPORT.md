# Site redesign report — "The Cutting Room"

Branch `redesign/cutting-room`. The route-by-route summary, Lighthouse scores,
review scores and dependencies are filled in at the end of the redesign;
every change to visitor-facing words is in [CONTENT_CHANGES.md](CONTENT_CHANGES.md).

## Mock-ups of the app and their footage (MOCKUP_FIX_PROMPT.md)

### What the pictures are now

Every picture of the app on the site is a drawing of the real web editor
(`web/src`), made from its own markup and Tailwind class names, not a
screenshot and not an invented UI:

| Where | What it shows |
| --- | --- |
| Home hero (4 beats, pinned scroll; a timer on phones) | the create wizard's file step → its outcome step and review → the job progress page → the timeline editor with the cut playing |
| Home, three steps (`StepMockup`) | the same screens at rest; on a narrow column, the part of each window that matters |
| Home, six feature strips (`MicroDemos`) | the caption lane, the music lane and its volume, a scene being trimmed, a scene swapped for a backup shot, clips converted on the server, the export row being ticked |
| Home, three feature cards (`FeatureVisual`) | the timeline block, the project page's script panel, the whole editor in a browser tab |
| /pricing | the settings page's quota card with sample numbers |
| /signup, /login | the editor, playing |

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
  any page width; phones and narrow columns crop into it.
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
  playhead slider, which is named "หัวเล่น" with the time as its value;
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
   Playwright (ANGLE's OpenGL backend: Metal mis-refracts). Five shots
   (pedestal dolly-in, serum drops macro, turntable, flat-lay, rack focus),
   84 frames each at 24 fps, 540×960, 64 samples a pixel (~16 s a frame on
   this Mac; a fresh browser per shot). Glass, amber serum and gold collar are
   physical materials; the linen sweep, oak edge and travertine plinth use
   textures generated in code (`textures.js`, no downloaded assets); the label
   reads only "FACE SERUM / Serum / 30 ml · 1 fl oz" — no brand.
2. `denoise.py` — the path tracer's grain removed without blurring the label:
   each frame's ±6 neighbours are aligned onto it with dense optical flow
   (OpenCV DIS, on blurred copies) and averaged, keeping the samples nearest
   their median (fireflies drop out), then a light non-local-means pass.
3. `encode.mjs` — the eight-scene cut the mock-ups' lanes are laid out from
   (`src/components/mockups/footage.json`), graded (light sharpening, lens
   vignette, a little temporal smoothing), a keyframe every half second for
   scrubbing; scene stills and three extra stills as AVIF + WebP; one filmstrip
   sprite (54×96 tiles). File URLs carry a content hash
   (`footage-version.json`) and are served as immutable.

Files in `public/footage/`: `edit.mp4` 491 KB (H.264), `edit.webm` 399 KB
(VP9), 8 scene stills + 3 backup-shot stills (AVIF and WebP, 2–8 KB each),
`strip.webp` 11 KB — **1.1 MB in all** (limit 4 MB). The cut is 14.6 s.

Performance rules: no video loads until its mock-up is near the screen
(`preload="none"`, sources added on demand); it plays only on screen, with its
beat showing and the tab visible; one at a time on a phone, two on a desktop;
reduced motion, Save-Data or a low-power device get the stills; nothing is in
the critical path (the hero's H1 stays the LCP).

To rebuild: `node render.mjs --out FRAMES --w 540 --h 960 --spp 64 --fps 24`
(with `PLAYWRIGHT_MODULE` set), then
`python denoise.py --frames FRAMES --out CLEAN` (OpenCV + NumPy), then
`node encode.mjs --frames CLEAN`.
