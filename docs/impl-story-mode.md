# Implementation plan: story mode (talking head + b-roll + motion graphics)

Companion to `docs/plan-aroll-broll-motion-mode.md` (the WHAT and the owner decisions). This
file is the HOW: build order, files, schemas, tests and gates. It is meant to be executed in
one long run by a Claude Code session, phase by phase, ticking the checklist at the bottom.
Written 2026-10-02; revised the same day after the owner's answers (§0).

**Scope: web editor (`web/`) + backend only. No desktop work** (owner, 2026-10-02 —
customers use the web editor only; deliberate scope, so no PARITY.md entry).

Internal mode name: `story`. UI name: **"เล่าเรื่อง + ภาพประกอบ"** (default; owner may rename).
UI never names an AI vendor.

**Not only sales clips.** Content ranges from product reviews to long rambling live-stream
talk. Every prompt is content-agnostic: the concept step must find a story inside an
unscripted talk (like `speech_highlights` does) as well as structure a scripted ad.

---

## 0. Owner answers (2026-10-02) and what they change

| Topic | Answer | Effect on this plan |
|---|---|---|
| Stock images (Pexels/Pixabay/Unsplash) | not now | Stock stage is built as a disabled hook only (§3.4); visual fill = user b-roll → graphic → text card. No API keys needed. |
| Test footage | owner sends raw live-stream talk clips (not sales); Claude makes the b-roll itself | §9: fixture builder records screen captures and makes photo/b-roll sets per topic; also test the **no-b-roll** case. |
| Remotion | reason for the 2026-08-12 removal unknown; bring it back if it gives the best effects/overlays | **Remotion is the render engine of this mode** (§1). |
| Effects, transitions, overlays, SFX | **never hand-write them** — use ready-made libraries/assets; "we cannot beat the market by writing our own" | §4 lists the sources; our code only wires, parameterises and composites. Procedural SFX and hand-rolled shaders are out. |
| Plans that get the mode | default: every plan incl. Free trial (quota pays) | §3.2 |
| Model per step | default: storyboard + graphics on the Director engine, understand + QA on Scout | §3.4 |

Ship rule: everything merges to `main` behind `STORY_MODE_ENABLED=false` + an allow-list
(`STORY_MODE_ALLOWLIST`, comma-separated emails). Production stays unchanged until the owner
flips it. Work happens on branch `feature/story-mode`; merge to `main` only at the end of a
phase whose gate is green (main auto-deploys).

### 0.1 Remotion licence (checked 2026-10-02 — re-check at P0)
Free licence: individuals and for-profit companies with **up to 3 employees**, commercial use
and automation allowed. A company of 4+ needs the Company licence; a product that renders
videos for its customers then falls under **"Remotion for Automators": $0.01 per render,
$100/month minimum**. Noey today = free tier. Record the check in `THIRD_PARTY_ASSETS.md`
and add a line to `docs/unit-economics.md` for the day the team grows past 3.
Sources: remotion.dev/docs/license/pricing, remotion.dev/docs/license/faq.

---

## 1. Architecture

One Remotion composition (`StoryVideo`) is the whole video. The storyboard is its input
props. Everything visual is a Remotion component from an existing package or asset pack.

```
web (browser)                                     backend (API + worker)            Noey Graphics (new service)
───────────────                                   ──────────────────────            ───────────────────────────
Wizard: A-roll + b-roll + brand kit + brief
ingest (existing) → proxies, WAV, photo downscale
upload ───────────────────────────────────────▶ POST /videos/{uid}/story/understand
                                                 task story_understand_local:
                                                   STT (existing Scribe) → 1 model call
                                                   → broll_index.json, keep.json, concepts.json
Concept picker ◀──────── waiting_user ───────────
POST /story/storyboard {conceptIds} ───────────▶ task story_storyboard_local: 1 call
                                                   → storyboard.json (validated, catalog-bound)
Storyboard player = @remotion/player playing
  StoryVideo on the 480p proxies (real motion,
  real captions, real audio) + per-shot notes
  notes → POST /story/revise ──────────────────▶ task story_revise_local: 1 call (noted shots)
  approve → POST /story/approve ───────────────▶ task story_produce_local (one run):
                                                   templates → params only (no call)
                                                   1 custom-graphics call ───────▶ Remotion renderer (server):
                                                   1 QA call on rendered frames ◀── transparent clip + QA stills
                                                   0–1 fix call → re-render failing pieces
                                                   → story/graphics/* in the bucket
download story/ assets → OPFS
person matte pass (MediaPipe) for cut-out shots
final render: @remotion/web-renderer renderMediaOnWeb(StoryVideo) on the full-res footage
  (fallback: server render, §1.2)
Result page: per-shot notes → revise → re-produce changed shots → re-render
```

Model calls per job: understand 1 + storyboard 1 + custom graphics 1–2 + QA 1 + fix 0–1 =
**4–6** (stock pick returns when stock is enabled); each revision round 1–2.

### 1.1 Why this split
- **Remotion** brings the effects ecosystem we must not write ourselves: `@remotion/transitions`,
  `@remotion/light-leaks`, `@remotion/motion-blur`, `@remotion/lottie`, `@remotion/captions`
  (+ the official open-source TikTok captions template), `@remotion/three` (WebGL shader
  effects), `@remotion/media` (`<Video>`/`<Audio>`), `@remotion/player` (live preview).
  Models also write Remotion code well.
- **Trusted code runs on the client; AI-written code never does.** Templates and catalog
  components (our repo, reviewed) run inside `StoryVideo` in the browser. AI-written custom
  graphics are rendered on the Noey Graphics server in a sandbox to a transparent video; the
  browser only plays the resulting video file. No AI-written JavaScript ever executes on our
  web origin.
- **Footage stays on the user's machine** (existing product promise): the final render runs
  in the browser on the original files in OPFS.

### 1.2 Render-path spike (P0, decides before anything is built on it)
`@remotion/web-renderer` is **experimental alpha** (Remotion docs, 2026-10). Supported:
`<Video>`/`<Audio>` from `@remotion/media`, `<Img>`, `<Lottie>`, `<ThreeCanvas>`, CSS
transforms, opacity, filters (not in Safari), text-stroke/shadow. Unsupported: `z-index`,
`mix-blend-mode`, `backdrop-filter`, `perspective`, `<OffthreadVideo>`.
Spike: a 60 s composition with 2 footage clips, one transition from each source (§4), a light
leak, a Lottie sticker, TikTok-style captions in Kanit, a transparent overlay video, a person
matte layer. Measure: correctness vs a server render of the same composition, speed (target
≥0.5× real time on an M1 / mid Windows laptop), memory, Chrome + Edge.
- **Pass** → final render in the browser (the plan as written).
- **Fail** → fallback: upload the used footage ranges (existing presigned upload) and render
  on Noey Graphics with `@remotion/renderer`; the composition code is identical, only the
  render call moves. Billing: render minutes are not AI tokens — count them under the plan's
  existing render/transcode feature (owner to price if this path is taken).
Write the result into this file (§11) before P2.

---

## 2. Data contracts (write these first; everything else codes against them)

All JSON lives under the project's output dir `story/` (server: `data_root()/video_outputs/<uid>/story/`,
S3 `videos/<uid>/outputs/story/...`, client OPFS `noeyfs://projects/<uid>/story/`).
Pydantic models in `backend/packages/video/story/schema.py`; mirrored TS types in
`web/src/lib/story/types.ts`; a contract test asserts the enums are identical.

### 2.1 Catalog (`backend/packages/video/story/catalog.py` + `web/src/lib/story/catalog.ts`)
The menu the AI picks from. Every entry maps to a ready-made source (§4). Response schemas
build their `enum`s from it, so the model cannot order something the renderer cannot draw.
The exact entry list is filled in P1 from what the sources actually provide; the shape:

- `LAYOUTS`: `aroll_full`, `broll_full`, `cutout_over_broll` (slots `bottom_center_large`,
  `bottom_left`, `bottom_right`), `split_top_bottom`, `pip_corner`, `phone_mockup`,
  `result_card` (framed clip on its own blurred copy + top/bottom chips), `graphic_full`,
  `text_card`. Layouts are composition structure (positioning of layers) — ours by necessity.
- `TRANSITIONS`: `{id, source: "remotion" | "gl-transitions", name, params}` — e.g.
  remotion `fade`/`slide`/`wipe`/`flip`/`clockWipe`/`iris`, gl-transitions `crosszoom`,
  `directionalwarp`, `glitchmemories`, `cube`, `dreamy`, … plus `light_leak` overlays.
- `EFFECTS` (on a layer, for a time range): from `@remotion/motion-blur`, `@remotion/three`
  + the `postprocessing` library (glitch, chromatic aberration, noise/film grain, vignette,
  bloom, pixelation), CSS filters (grayscale for the "problem" beat, blur), camera moves
  driven by Remotion `interpolate`/`spring` presets (`push_in`, `punch_in`, `ken_burns`,
  `shake`) anchored on the face box.
- `CAPTION_STYLES`: from `@remotion/captions` + the TikTok template's page/highlight logic,
  restyled with our fonts/brand colours; animations offered by those components.
- `OVERLAYS`: Lottie animations from the curated pack (stickers, arrows, check marks,
  confetti, emoji, frames, call-to-action bubbles), light leaks.
- `SFX`: tag list of the curated CC0 pack (§4.4), e.g. `whoosh`, `pop`, `click`, `typing`,
  `impact`, `ding`, `riser`, `glass`, `cash`, `stamp`, `rewind`.
- `TEMPLATES` (id → params JSON-schema): motion-graphic templates built from Remotion
  components + Lottie: `title_card`, `feature_chips`, `price_ticket_countup`,
  `discount_code`, `badge_stamp`, `sticker`, `mascot_pop`, `timer_chip`, `checklist`,
  `steps`, `comparison_table`, `bar_chart`, `pie_chart`, `star_rating`, `cart_cta`,
  `end_card`, `counter`, `quote_card`, `topic_title` (the last two for talk/live content).
  Start from existing open-source Remotion templates/examples where one fits (licence-checked).

### 2.2 `broll_index.json`
`{files:[{id, kind: video|photo|screen, durationSec?, summary, tags[], usable:[{in,out,what}], text_on_screen?}]}`

### 2.3 `keep.json` (A-roll cleanup)
`{ranges:[{clip, fromWord, toWord}], dropped:[{clip, fromWord, toWord, why: silence|flub|retake|filler|off_topic}]}`
— word INDICES into `transcript.json`, never timestamps. Code converts to times with the
existing snapping (`audio_edges.py`).

### 2.4 `concepts.json`
`{concepts:[{id, title, hook, beats[{label, words:[fromWord,toWord]}], tone, targetSec, brollIds[]}]}` —
2–3 items written by the model per job (owner decision: no fixed list in code). For a long
live talk a concept is a self-contained story picked out of it; several concepts may cover
different parts (like `speech_highlights`), and picking 2 makes 2 clips.

### 2.5 `storyboard.json` (single source of truth; = `StoryVideo` input props)
```jsonc
{
  "version": 1, "conceptId": "c1", "fps": 30, "size": [1080, 1920],
  "brand": {"primary": "#…", "accent": "#EAFF07", "font": "kanit", "logo": "brand/logo.png?"},
  "captionStyle": "tiktok_pop",
  "shots": [{
    "id": "s01", "beat": "hook",
    "aroll": [{"clip": "a1", "fromWord": 12, "toWord": 19}],
    "layout": "cutout_over_broll", "slot": "bottom_center_large",
    "visual": {"source": "broll|graphic|text_card|none", "ref": "b07", "in": 2.0, "out": 4.1, "mute": true},
    "graphic": {"template": "price_ticket_countup", "params": {}} | {"custom": "g03", "spec": "…"} | null,
    "super": {"lines": ["ฟุตเยอะ แต่", "ขี้เกียจตัด"], "emphasis": [[1,0,10]], "at": "word:14"} | null,
    "camera": {"preset": "punch_in", "at": "word:15"},
    "transitionIn": {"id": "gl:crosszoom", "durationFrames": 9},
    "effects": [{"id": "grayscale", "from": "start", "to": "end"}],
    "overlays": [{"id": "lottie:arrow_down_01", "at": "super", "slot": "top_right"}],
    "sfx": [{"tag": "whoosh", "at": "start"}, {"tag": "pop", "at": "super"}],
    "emotion": "excited", "note": ""
  }],
  "music": {"track": "music/user.mp3?", "duckDb": 3, "bedDb": -14}
}
```
Times are anchors (`start`, `end`, `super`, `word:<index>`) resolved by code
(`web/src/lib/story/resolve.ts`, pure) → the model never does arithmetic on seconds.

Validation (`backend/packages/video/story/validate.py`, mirrored in TS): words exist and are
inside `keep.json`; shots cover every kept range of the concept in order exactly once; every
`id` exists in the catalog; template params validate; every number shown appears in the
transcript or brief (owner rule: no invented data). Failing items degrade (unknown
transition → `cut`, bad graphic → `text_card`) with a logged reason.

### 2.6 Graphics manifest `story/graphics/manifest.json`
`{items:[{id, shotId, durationSec, file: "graphics/g03.webm", qa: pass|fixed|fallback}]}` —
transparent video of each AI-written custom graphic. Container/codec decided in the P0 spike:
VP9-alpha WebM if `@remotion/media` decodes its alpha in the browser, else stacked-alpha H.264
(colour over alpha, recombined by a small ready-made-free mask layer — the only custom
compositing code allowed, since it is plumbing, not an effect).

---

## 3. Backend

### 3.1 Settings (`packages/core/settings.py`, `.env.example`, `docs/railway-deploy.md`)
`story_mode_enabled: bool=False`, `story_mode_allowlist: str=""`, `story_stock_enabled: bool=False`
(+ `pexels_api_key`, `pixabay_api_key`, `unsplash_access_key`, all optional, unused while
disabled), `graphics_service_url` (`http://noey-graphics.railway.internal:8080`),
`graphics_service_token`, `story_understand_model`, `story_board_model`,
`story_graphics_model`, `story_qa_model` (defaults from `quality.py` tiers). Exposed to the
client as `features.story` on the existing `/auth/me` payload.

### 3.2 Mode registration (no migration — `mode`/`stage`/`status` are plain strings)
- `videos_local.py:create_local_project` allow-list += `story` (flag/allow-list off → 404).
- `models/video_project.py`: `VIDEO_STATUS` += `waiting_user`; `PIPELINE_STAGES`/`STAGE_ORDER["story"]`
  = `imported → understood → boarded → produced → rendered`; `PAID_STAGES`.
- `packages/billing/resume.py:SERVER_STAGES` += story stages; router `_STAGE_KIND`,
  `_reached_stage`, `_resting_status` (`waiting_user` is resting and restartable).
- `_WEB_FILE_ROOTS` += `story`, `broll`, `brand`.
- `plan_features.py`: `FOOTAGE_KINDS` += `story_understand`; A-roll cap = `SPEECH_FOOTAGE_SEC`
  (2 h, so a live-stream recording fits); b-roll cap 40 files / 10 min of video.
- `llm/usage.py:_TASK_BY_FEATURE` += `story_*`.

### 3.3 Billing (`packages/billing/estimate.py`)
New `Kind`s + `MODE_PROFILES`, sized from the request:
| kind | calls | inputs priced | output sizing |
|---|---|---|---|
| `story_understand` | STT + 1 | A-roll audio sec (STT) + A-roll video at 1 fps + b-roll video sec + photos | thinking + 120×concepts + 40×b-roll files + keep ranges (~1 per 10 words) |
| `story_board` | 1 per picked concept | transcript + index + concept | thinking + 220×expected shots (0.43 shots/s of target) |
| `story_revise` | 1 | storyboard + notes | thinking + 220×noted shots |
| `story_produce` | 1–3 | graphic specs + QA frames | thinking + 2,500×custom graphics (split above 40k) |
Three separate runs: understand at wizard submit, board at concept pick, produce at approve
(each its own strict start gate; resume exempt). `finish_reason=length` → `safety_cap`, no
auto-retry. A 2-hour live A-roll is big input for one call: measure in P9; if the
understand call exceeds the model's input context, the route refuses with
`footage_over_limit` (same rule as existing modes) — no chunking in v1.

### 3.4 Prompts + calls (`backend/packages/video/story/`)
One module per call: system prompt constants + `RESPONSE_SCHEMA` from the catalog +
`async def run_*` using `upload_gemini_file` / `gemini_video_block` /
`acompletion_stream_thinking` like `dub_ai.generate_dub_edit_script_video` (Files API, many
files in one message, `finally: delete_gemini_files`).
- `understand.py` — A-roll proxy (fps 1), b-roll proxies (fps 1) + photos, word list
  `[i] word (start)`, Scribe silence gaps, brief → index + keep + concepts. Rules: content-
  agnostic; best take per line (retake detection, not only silence removal), drop flubs,
  repeats, fillers and off-topic stretches; never reorder lines; never speed up. Code trims
  pauses to 100–250 ms with 50–100 ms word-edge padding (measured on Kitti: median gap
  ~160 ms; ~60–67 % of a scripted raw removed; a live talk keeps far less).
- `storyboard.py` — concept, kept words, b-roll index (text only), brand, catalog prose,
  style defaults (§3.5) → storyboard.
- `revise.py` — storyboard + notes `{shotId: text}` → only the noted shots; code merges and
  re-validates.
- `stock.py` — built, disabled (`story_stock_enabled=False`); no route offers it.
- `graphics_code.py` — ONE call writes every `custom` graphic as a Remotion component file
  following the Graphics Contract (§5.2) → `{items:[{id, tsx}]}`; two calls if the estimate
  passes 40k output tokens. Custom graphics are the exception: the storyboard prompt
  prefers templates + Lottie overlays.
- `graphics_qa.py` — ONE vision call over a contact sheet (3 stills per graphic) → `{items:[{id, ok, problems[], fix}]}`
  (overflow, safe area, Thai tone marks/cut words, contrast, invented numbers).
- `graphics_fix` — one call for failing items; failing twice → `text_card` template.

### 3.5 Style defaults (`style_defaults.py`, measured from Kitti's result clip — §12)
Shots 0.8–3 s (median ~2.1 s); A-roll full-frame ≤35 % of time; every A-roll jump cut
hidden under a cutaway, a flash or a zoom reset; super text = rewritten 2–5-word summary with
one emphasised keyword on most shots; an SFX on every cut and super (~25–40 per 90 s);
punch-ins on climax words only (≤3 per minute); music bed 13–15 dB under the voice. For a
live talk with no b-roll: graphics, quote cards, topic titles and camera moves carry the
cutaways instead.

### 3.6 Worker tasks (`services/worker/tasks.py`, registered in `WorkerSettings.functions`)
`story_understand_local`, `story_storyboard_local`, `story_revise_local`,
`story_produce_local` — all `@billed_task()`; produce checkpoints each sub-step
(`graphics` → `qa` → `fix`) with `_finish_stage` so a `paused_quota` resume restarts at the
sub-step; `_release_connection` before each model call. Results go to `story/`,
`_push_project_files`, then project → `waiting_user` (understand, board, revise) or `produced`.

### 3.7 Routes (`services/api/routers/story.py`)
Same pattern as `analyze_video` (lock row → idempotency → refuse running → estimate →
`start_paid_run` → `_queue_job_row` → `_open_stage` → enqueue):
- `POST /videos/{uid}/story/understand` (multipart: A-roll WAVs, A-roll + b-roll proxies,
  photos ≤1600 px, brand files, manifest)
- `POST /videos/{uid}/story/storyboard` `{conceptIds[] (1–2)}`
- `POST /videos/{uid}/story/revise` `{notes:{shotId:text}}` (≤40 shots, ≤500 chars each)
- `POST /videos/{uid}/story/approve` → produce
- `GET /videos/{uid}/story` → `{stage, concepts?, storyboard?, graphics?}`
- `PUT /videos/{uid}/story/storyboard` (manual edits from the player; validated, no AI)

---

## 4. Ready-made sources (owner rule: never hand-write effects, transitions, overlays, SFX)

Every source gets a row in `THIRD_PARTY_ASSETS.md` (name, version/commit, licence, URL,
what we use, date checked). Accept only licences that allow commercial use inside a SaaS
that renders videos for customers: MIT, Apache-2.0, BSD, ISC, zlib, CC0, or explicit
written terms. Anything else (CC-BY-NC, "no redistribution as a library", unclear) is out.

### 4.1 Video engine and effects
| Need | Source | Note |
|---|---|---|
| Composition, timing, interpolation, springs | `remotion`, `@remotion/media` | licence §0.1 |
| Transitions | `@remotion/transitions` (fade, slide, wipe, flip, clockWipe, iris, …) + **gl-transitions** (GLSL collection, run through a `@remotion/three` presentation) | check the licence header of every gl-transition file; keep only permissive ones |
| Light leaks | `@remotion/light-leaks` | |
| Motion blur | `@remotion/motion-blur` | |
| Glitch, grain, chromatic aberration, vignette, bloom, pixelation | `postprocessing` (pmndrs) on `@remotion/three` | |
| Lottie overlays | `@remotion/lottie` + `lottie-web`; animations curated from LottieFiles free assets (verify the Lottie Simple License per file) | stored in `web/public/story/lottie/` |
| Captions | `@remotion/captions` + Remotion's open-source TikTok template (page grouping, word highlight) | our fonts (Kanit, Prompt, Sarabun, Anuphan — OFL, already bundled) |
| Person matte | MediaPipe Tasks Vision image segmenter (Apache-2.0), model self-hosted | |
| Live preview | `@remotion/player` | |
| Final render | `@remotion/web-renderer` (fallback `@remotion/renderer`) | §1.2 |

### 4.2 Motion-graphic templates
Built as Remotion compositions out of the parts above (Lottie + transitions + captions +
`@remotion/shapes`/`@remotion/paths` where needed). Before writing a template, search for an
existing open-source Remotion template/example that does it (licence-checked) and adapt it.

### 4.3 Camera moves
Remotion `interpolate`/`spring` with named presets is the documented way to animate in
Remotion (not a custom effect engine); presets copy the parameters measured on Kitti
(punch +12–18 % in 0.2–0.3 s, push 1–2 %/s, settle −2.4 % in 0.15 s, shake ≤8 px), anchored on
the face box (Kitti's zoom anchored top-left — visible bug; avoid).

### 4.4 Sound
- **SFX**: a curated pack of ~80–120 files from CC0 sources (Kenney audio packs, Freesound
  filtered to CC0), normalised to −16 LUFS short-term, trimmed, tagged in
  `web/public/story/sfx/index.json` `{tag, file, durationMs, licence, source}`. The storyboard
  picks by tag; code picks a file per tag deterministically (seeded by shot id) so repeats
  vary. No procedural SFX.
- **Music**: user upload (existing) in v1. A CC0/royalty-free music library is a later item
  (licence must allow in-app redistribution).
- Mixing: Remotion `<Audio>` volume curves (voice-driven duck via the voice RMS envelope
  computed once), final loudness to −14 LUFS / −1 dBTP with an existing library
  (e.g. an EBU R128 / BS.1770 meter package, licence-checked) applied as gain before encode.

---

## 5. Noey Graphics service (`graphics/`, new Railway service)

### 5.1 Service
- Scaffold with Remotion's own generator (`npx create-video@latest graphics --blank`) + a
  small HTTP server; Dockerfile per Remotion's Docker docs (Chrome Headless Shell + Thai
  fonts from `backend/data/fonts/` + Noto Sans Thai, `fc-cache`), digest-pinned.
- `POST /render` `{tsx | templateId+params, durationInFrames, fps:30, width:1080, height:1920}`
  (bearer `GRAPHICS_SERVICE_TOKEN`) → transparent video (§2.6). `POST /stills`
  `{…, frames[]}` → PNGs for QA.
- AI-written TSX is bundled per request into an isolated temp project that imports only an
  allow-list of packages (remotion, @remotion/{shapes,paths,lottie,transitions,layout-utils},
  our template kit); the bundler rejects any other import, `fetch`, `XMLHttpRequest`,
  `WebSocket`, `eval`, `import()`; Chrome runs with request interception aborting every
  non-local URL; per-render limits: 60 s wall, 15 s of graphic, 1 GB memory; no secrets in
  env except the token; private network only (no public domain).
- Concurrency 2 per instance, in-memory queue, 429 when full (worker retries with backoff).

### 5.2 Graphics Contract (given to the model verbatim; contract-tested)
A single `.tsx` default-exporting a component `({params, brand}) => JSX`; uses
`useCurrentFrame`/`useVideoConfig`/`interpolate`/`spring` only for motion; transparent
background; safe area 90 px sides / 220 px top / 380 px bottom; font via `brand.font`; colours
via `brand`; every number/word shown comes from the shot spec; ≤40 KB.

---

## 6. Web client

### 6.1 Wizard + mode plumbing
- `lib/wizardState.ts`: `UiMode` += `story`; `backendMode('story')='story'`; gates: ≥1 A-roll,
  0–40 b-roll, brand kit optional; hidden unless `features.story`.
- `components/wizard/WizardStepFiles.tsx`: role per file (A-roll / b-roll, user can flip);
  photos (jpg/png/webp; heic → jpg via canvas); brand kit drawer (logo, mascot, primary +
  accent colour, caption font from `CAPTION_FONTS`).
- `lib/projectFlow.ts`: `STORY_STEP_ORDER = importing → understanding → concepts → boarding →
  storyboard → producing → assets → matting → rendering → done`; `lib/modeLabel.ts` label.
- New `lib/storyPipeline.ts` (do not grow the 3,347-line `useProjectPipeline.ts`; call into
  it at the existing mode switch points) + `lib/storyApi.ts` (typed client for §3.7, reuses
  `pollJob`, `estimateUsage`, idempotency key).
- Remotion packages go into `web/package.json` via `npm i` (pinned exact versions, same
  version for every `@remotion/*`).

### 6.2 Ingest additions (`engine/jobs/`)
`ingest.ts` accepts photos; `extractProxy.ts` reused for b-roll; new `storyAssets.ts`
downloads `story/graphics/*` to OPFS (resume-safe, sizes checked against the manifest).
The media service worker already serves OPFS files to `<Video>` via `/media/<uid>/<rel>`.

### 6.3 Concept picker (`pages/story/ConceptPage.tsx`)
2–3 cards (title, big hook, beats, tone, est. length); pick 1–2 → estimate → storyboard.
"ขอแนวใหม่" re-runs understand (billed; in-app confirm modal, never `window.confirm`).

### 6.4 Storyboard player (`pages/story/StoryboardPage.tsx`)
- `@remotion/player` plays the real `StoryVideo` on the 480p proxies: real transitions,
  captions, overlays, SFX and the A-roll sound (Kitti's player showed stills and could not
  load audio). Custom graphics not produced yet show as a labelled placeholder card.
- Horizontal shot strip (equal-width cards: index, beat, time, duration), ←/→, Space.
- Per-shot panel: VO line, super text (inline edit), layout / transition / effect / overlay /
  SFX chips editable from the catalog, swap b-roll from the index, note box.
- Footer: "ส่งโน้ตให้ AI แก้" (notes → revise, estimate shown), "อนุมัติแล้วสร้างคลิป"
  (approve → produce). Manual edits save via `PUT /story/storyboard`, free.

### 6.5 `StoryVideo` composition (`web/src/story/`)
- `StoryVideo.tsx` — `<TransitionSeries>` of shots; each shot = layout component + layers
  (A-roll `<Video>` ranges, b-roll `<Video>`/`<Img>`, matte layer, graphic video, Lottie
  overlays, captions, effects wrappers, camera preset); `<Audio>` for voice ranges, SFX, music.
- `layouts/*.tsx`, `catalog/*.tsx` (thin wrappers that map catalog ids to the packages in §4),
  `templates/*.tsx` (§4.2), `captions/StoryCaptions.tsx` (TikTok template logic + super text).
- `resolve.ts` (pure, tested) — anchors → frames.
- Render job `engine/jobs/renderStory.ts` registered like the other jobs; calls
  `renderMediaOnWeb` (or the server fallback), writes `final.mp4` via the staged OPFS write,
  honours `job.signal`.

### 6.6 Person matte (`web/src/story/matte.ts`)
MediaPipe segmenter over only the A-roll ranges used by cut-out layouts, 15 fps, temporal
smoothing (the segmenter's own option where available), stored as `story/matte/<clip>_<in>.webm`
so re-renders skip it; also emits the face/head box for camera anchors and caption avoidance.

### 6.7 Result page (`pages/story/StoryResultPage.tsx`)
Player + shot strip; per-shot notes → revise → produce only changed custom graphics
(manifest diff) → re-render. Download MP4.

---

## 7. Security & safety checklist (each one has a test)
1. AI-written TSX runs only inside Noey Graphics; the browser receives video files only.
2. Graphics service: private network, bearer token, import allow-list, network aborted,
   time/memory caps; test inputs that `fetch`, import `fs`, loop forever or allocate 2 GB must
   fail closed.
3. Every third-party package/asset has a licence row (§4); a test fails when a file under
   `web/public/story/` is missing from `THIRD_PARTY_ASSETS.md`.
4. No invented numbers: validator on storyboard + custom graphic text.
5. Uploads: existing size/type checks; b-roll counts toward storage quota.
6. No AI vendor names in UI strings (extend the existing grep test to `story/`).

---

## 8. Build order (each phase ends with its gate green and a commit)

| Phase | Deliverable | Gate |
|---|---|---|
| P0 | Branch, settings, flag; licence checks (§0.1, §4); **render-path spike** (§1.2) with results written to §11; catalog + schemas (py + ts) + contract test | spike numbers recorded; `pytest tests/test_story_schema.py`; `vitest src/lib/story` |
| P1 | Asset curation: transitions (Remotion + licence-filtered gl-transitions), effects, Lottie pack, CC0 SFX pack, `THIRD_PARTY_ASSETS.md`; catalog filled from them | licence test green; a catalog gallery page (dev only) renders every entry |
| P2 | `StoryVideo`: layouts, catalog wrappers, captions, camera presets, audio mix + loudness; render job | vitest (resolve, catalog mapping, loudness on reference tones ±0.5 LU); one Playwright run rendering `fixtures/story/demo.json` → contact sheet + MP4 reviewed; speed recorded |
| P3 | Templates (§4.2) | each template renders from its fixture params; golden stills compared (1 % tolerance) |
| P4 | Person matte + cut-out layouts | one Playwright run on a fixture clip → contact sheet |
| P5 | Noey Graphics service + Graphics Contract + sandbox; deployed on Railway (private) | `graphics: npm test` incl. sandbox escapes; smoke render from the worker host |
| P6 | Backend: mode registration, billing kinds, routes, tasks with fake-AI fixtures | pytest: routes (flag off → 404), estimates, billed tasks, resume per sub-step, `test_every_ai_task_is_billed_and_registered_by_name`, admin security walk |
| P7 | Prompts: understand, storyboard, revise, graphics code, QA, fix | pytest call-site tests (monkeypatched gateway); validator tests incl. invented numbers |
| P8 | Web UI: wizard, concept picker, storyboard player, result page, pipeline | vitest; `npm run typecheck && npm run lint && npm run build`; one Playwright happy path with `LOADTEST_FAKE_AI=1` locally |
| P9 | Hardening: resume after `paused_quota` at every stage, cancel, reload mid-job, lost network during asset download, re-render idempotency | pytest + vitest per case |
| P10 | Live eval (§9): owner's live-talk clips + self-made b-roll, ≥3 runs each (cut-prompt eval method), contact sheets + MP4s in `docs/story-eval/`; tune prompts and estimate constants; record tokens, calls, wall time, render speed | owner reviews the eval doc |
| P11 | Merge to `main` with the flag off, deploy, watch logs; enable for the allow-list | deploy green; production smoke with the owner's account |

Run rules: test as you go (repo rule 6); Playwright only for the single runs above; full
backend + web suites before every merge; English commit messages; check `origin/main..main`
and alembic heads before pushing (other sessions push to main); at the end update
`CLAUDE.md`/`AGENTS.md` code map (`packages/video/story/`, `graphics/`, `web/src/story/`)
and this checklist.

---

## 9. Test material
- **A-roll**: the owner's raw live-stream talk clips (rambling, unscripted, not sales).
  Stored outside the repo (`~/noey-story-fixtures/<name>/aroll/`), never committed.
- **B-roll, made by Claude** per clip topic, after reading the transcript:
  screen recordings of relevant public web pages (Playwright `recordVideo`, scrolling,
  9:16 viewport), screenshots as photos, and short clips cut from other parts of the owner's
  own footage; no downloads from stock sites. Stored beside the A-roll.
- Three variants per clip: rich b-roll (10–20 files), thin b-roll (2–3), **no b-roll**.
- Unit/CI fixtures: tiny generated clips (`tests/media_helpers.py`) + `fixtures/story/*.json`.

## 10. Fake AI
Extend `packages/llm/fake.py:build_answer` with canned VALID answers for the story schemas
(routed by schema `title`), built from `tests/fixtures/story/*.json`, so the flow runs end to
end with `LOADTEST_FAKE_AI=1` and no vendor cost.

## 11. Spike results (filled in P0)
_pending_

## 12. Style reference (measured from Kitti's own result clip, 90.8 s)
39 visual segments, median 2.1 s; A-roll full 28 %, b-roll 30 %, motion graphics 19 %,
result card 12 %, cut-out over b-roll 10 %; super text = rewritten 2–5-word summaries, white +
lime `#EAFF07` keyword, thick black outline, pops in 0–0.3 s before the word; ~40 SFX events;
6 white flashes (3 frames) hiding jump cuts; 2 punch-ins (+13–15 % in 0.2 s) on climax words;
music bed 13–15 dB under voice with ~3 dB duck; −14.1 LUFS. Raw→edit on their scripted take:
whole first take dropped (retakes), pauses trimmed to ~100–250 ms, no speed-up, no reordering.

## 13. Known risks
- `@remotion/web-renderer` is experimental → the P0 spike decides; server fallback ready.
- Remotion licence changes with team size (§0.1).
- Render speed and memory in the browser for long outputs (a live talk can produce several
  clips) — measured in P0/P2.
- Model taste: storyboard quality needs P10 iterations (budget 3 prompt rounds).
- A 2-hour live A-roll may not fit one understand call → `footage_over_limit` in v1.
- MediaPipe matte quality on busy backgrounds.

---

## Checklist (the executing session ticks these)
- [ ] P0 spike + licences + contracts
- [ ] P1 asset curation
- [ ] P2 StoryVideo
- [ ] P3 templates
- [ ] P4 matte + layouts
- [ ] P5 graphics service
- [ ] P6 backend plumbing + billing
- [ ] P7 prompts
- [ ] P8 web UI
- [ ] P9 hardening
- [ ] P10 live eval (owner clips received: [ ])
- [ ] P11 merge + deploy (flag off) + allow-list
