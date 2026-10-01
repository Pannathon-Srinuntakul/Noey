# Implementation plan: story mode (talking head + b-roll + motion graphics)

Companion to `docs/plan-aroll-broll-motion-mode.md` (the WHAT and the owner decisions). This
file is the HOW: build order, files, schemas, tests and gates. It is meant to be executed in
one long run by a Claude Code session, phase by phase, ticking the checklist at the bottom.
Written 2026-10-02 against `main` @ 8cf21a1.

**Scope: web editor (`web/`) + backend only. No desktop work** (owner, 2026-10-02 —
customers use the web editor only; deliberate scope, so no PARITY.md entry).

Internal mode name: `story`. UI name: proposal **"เล่าเรื่อง + ภาพประกอบ"** (owner to confirm,
see §0). UI never names an AI vendor.

---

## 0. Before the run — owner inputs (blocking items marked ★)

| # | Item | Default if the owner says "use defaults" |
|---|---|---|
| ★1 | Test footage: 3 projects, each = 1 talking-head clip (2–5 min) + 5–20 b-roll files (video + photos + one screen recording), different product categories (e.g. skincare, gadget, apparel). Put them in `~/noey-story-fixtures/<name>/{aroll,broll}/`. | none — the live eval (Phase 9) cannot run without it |
| ★2 | Stock API keys: `PEXELS_API_KEY`, `PIXABAY_API_KEY` (+ optional `UNSPLASH_ACCESS_KEY`). Free to obtain. | stock fill disabled; visual fill skips to text card |
| 3 | UI name of the mode | "เล่าเรื่อง + ภาพประกอบ" |
| 4 | Which plans get the mode | every plan incl. Free trial (quota pays) |
| 5 | Model per step (engine tiers) | storyboard + graphics on the Director engine (`dub_engine_pro`), understand/stock/QA on Scout; no Pro-tier model → daily cap is not an issue |
| 6 | Why was the Remotion overlay layer removed on 2026-08-12? (or allow reading `git log` for that week) | assume "slow + broke on web"; this design renders graphics on a server and composites on the client, which avoids both |
| 7 | Music: user upload only in v1? | yes; SFX are synthesized in code (§6.4), so no sound library licence is needed |
| 8 | Railway: new service **Noey Graphics** (headless Chromium, private network only) | create it (Railway writes are pre-authorised; deletes still need asking) |

Ship rule: everything merges to `main` behind `STORY_MODE_ENABLED=false` + an allow-list
(`STORY_MODE_ALLOWLIST`, comma-separated emails). Production stays unchanged until the owner
flips it. Work happens on branch `feature/story-mode`; merge to `main` only at the end of a
phase whose gate is green (main auto-deploys).

---

## 1. Architecture in one page

```
web (browser)                                   backend (API + worker)               Noey Graphics (new service)
───────────────                                 ──────────────────────               ───────────────────────────
Wizard: A-roll + b-roll + brand kit + brief
ingest (existing) → proxies, WAV, photo downscale
upload ─────────────────────────────────────▶ POST /videos/{uid}/story/understand
                                               task story_understand_local:
                                                 STT (existing Scribe) → 1 Gemini call
                                                 → broll_index.json, keep.json, concepts.json
Concept picker  ◀──────── waiting_user ─────────
POST /story/storyboard {concept_ids} ────────▶ task story_storyboard_local: 1 call
                                                 → storyboard.json (validated, catalog-bound)
Storyboard player (stills + super text +
  A-roll audio, per-shot notes)
  notes → POST /story/revise ────────────────▶ task story_revise_local: 1 call (noted shots only)
  approve → POST /story/produce ─────────────▶ task story_produce_local (chained, one run):
                                                 stock search (HTTP) → 0–1 pick call → download
                                                 templates → params only (no call)
                                                 1 graphics-code call ──────────────────▶ POST /render (HTML → stacked-alpha MP4)
                                                 1 QA call on sampled frames ◀──────────
                                                 0–1 fix call → re-render failing pieces
                                                 → assets under story/ in the bucket
download story/ assets → OPFS
person matte pass (MediaPipe, client) for cut-out shots
StoryRenderer (WebGL2 compositor + audio graph) → final.mp4
Result page: per-shot notes → revise → re-produce only changed shots → re-render
```

Model calls per job: understand 1 + storyboard 1 + pick 0–1 + graphics 1–2 + QA 1 + fix 0–1
= **4–7**; each revision round 1–2. Every call goes through `packages/llm` and is billed.

Why the graphics render on a server: QA needs rendered frames inside the backend pipeline;
AI-written code must never run on our web origin (XSS surface); headless Chromium gives
identical output for every user. Why compositing stays on the client: the final footage
never leaves the user's machine (existing product promise); the web engine already has a
per-frame canvas loop (`engine/cutRender.ts` + `media.ts:encodeVideo`).

---

## 2. Data contracts (write these first; everything else codes against them)

All JSON lives under the project's output dir `story/` (server: `data_root()/video_outputs/<uid>/story/`,
S3 `videos/<uid>/outputs/story/...`, client OPFS `noeyfs://projects/<uid>/story/`).
Pydantic models in `backend/packages/video/story/schema.py`; mirrored TS types in
`web/src/lib/story/types.ts`; a contract test (§10) asserts the enums are identical.

### 2.1 Catalog (`backend/packages/video/story/catalog.py` + `web/src/lib/story/catalog.ts`)
The menu the AI picks from. Response schemas build their `enum`s from it, so the model cannot
order something the renderer cannot draw.

- `LAYOUTS`: `aroll_full`, `broll_full`, `cutout_over_broll` (slots: `bottom_center_large`,
  `bottom_left`, `bottom_right`), `split_top_bottom`, `pip_corner`, `phone_mockup`,
  `result_card` (framed clip on blurred self + top/bottom chips), `graphic_full`,
  `text_card`.
- `CAMERA`: `none`, `push_in_slow` (1–2 %/s), `punch_in` (+12–18 % in 0.2–0.3 s, ease-out,
  hold), `punch_out`, `settle` (start +2.4 %, ease back in 0.15 s), `ken_burns`, `pan_lr`,
  `pan_rl`, `shake` (≤8 px, ≤0.25 s). Zoom anchor = face centre from the matte/face box,
  never the top-left (Kitti's visible bug).
- `TRANSITIONS` (into the shot): `cut`, `white_flash` (3 frames), `zoom_blur`, `dissolve`
  (≤0.2 s), `slide_left`, `slide_up`, `shrink_to_pip`, `scale_into_card`, `whip`.
- `TREATMENTS`: `none`, `freeze_bw`, `glass_crack`, `fast_forward` (+ timer chip), `vhs_rewind`.
- `SUPER_ANIMS`: `pop` (0.7→1.1→1.0 in 4–6 frames), `typewriter` (Thai grapheme clusters via
  `Intl.Segmenter('th',{granularity:'grapheme'})`), `word_pop`, `keyword_bump`, `none`.
- `SFX`: `whoosh`, `swish`, `pop`, `click`, `tick`, `typing`, `thud`, `boom`, `impact`,
  `ding`, `chime_reveal`, `crack`, `kaching`, `stamp`, `rewind`, `riser`, `bell`.
- `TEMPLATES` (id → JSON-schema of params): `title_card`, `feature_chips`,
  `price_ticket_countup`, `discount_code`, `badge_stamp`, `sticker`, `mascot_pop`,
  `timer_chip`, `checklist`, `steps`, `comparison_table`, `bar_chart`, `pie_chart`,
  `star_rating`, `cart_cta` ("กดตะกร้า"), `end_card`, `counter`, `text_card`.

### 2.2 `broll_index.json`
`{files:[{id, kind: video|photo|screen, durationSec?, summary, tags[], usable:[{in,out,what}], text_on_screen?}]}`

### 2.3 `keep.json` (A-roll cleanup)
`{ranges:[{clip, fromWord, toWord, reason?}], dropped:[{clip, fromWord, toWord, why: silence|flub|retake|filler}]}`
— word INDICES into `transcript.json`, never timestamps. Code converts to times with the
existing snapping (`audio_edges.py`) so the cut lands in real silence.

### 2.4 `concepts.json`
`{concepts:[{id, title, hook, beats[{label, words:[fromWord,toWord]}], tone, targetSec, brollIds[]}]}` — 2–3 items,
written by the model per job (owner decision: no fixed concept list in code).

### 2.5 `storyboard.json` (the single source of truth for the render)
```jsonc
{
  "version": 1, "conceptId": "c1", "fps": 30, "size": [1080, 1920],
  "brand": {"primary": "#…", "accent": "#EAFF07", "font": "kanit", "logo": "brand/logo.png?"},
  "shots": [{
    "id": "s01", "beat": "hook",
    "aroll": [{"clip": "a1", "fromWord": 12, "toWord": 19}],      // audio + (maybe) picture
    "layout": "cutout_over_broll", "slot": "bottom_center_large",
    "visual": {"source": "broll|stock|graphic|text_card|none", "ref": "b07", "in": 2.0, "out": 4.1,
               "fit": "cover", "mute": true},
    "graphic": {"template": "price_ticket_countup", "params": {…}} | {"custom": "g03", "spec": "…prose…"} | null,
    "super": {"lines": ["ฟุตเยอะ แต่", "ขี้เกียจตัด"], "emphasis": [[1,0,10]], "anim": "pop",
              "at": "word:14"} | null,
    "camera": {"move": "punch_in", "at": "word:15"},
    "transitionIn": "white_flash", "treatment": "none",
    "sfx": [{"kind": "whoosh", "at": "start"}, {"kind": "pop", "at": "super"}],
    "stockQuery": {"en": "person editing video on laptop", "orientation": "portrait"} | null,
    "emotion": "excited", "note": ""
  }],
  "music": {"track": "music/user.mp3?", "duckDb": 3, "bedDb": -14},
  "alternates": {}
}
```
Times are anchors (`start`, `end`, `super`, `word:<index>`), resolved by code → the model
never does arithmetic on seconds. `resolveStoryboard()` (TS, pure) turns it into an output
timeline: `[{shotId, outStart, outEnd, arollRanges[{clip,in,out}], …}]`.

Validation (`backend/packages/video/story/validate.py`, mirrored in TS): words exist and are
inside `keep.json`; shots cover every kept range in order exactly once; `ref`s exist; template
params validate against the template schema; every number shown in `super`/`params` appears
in the transcript or brief (owner rule: no invented data) — failing items are dropped to
`text_card` with a logged reason, never sent back to the model automatically.

### 2.6 Graphics manifest `story/graphics/manifest.json`
`{items:[{id, shotId, kind: template|custom, durationSec, file: "graphics/g03.mp4", alpha: "stacked", qa: pass|fixed|fallback}]}`
Stacked alpha = H.264 1080×3840 (top half colour, bottom half alpha as luma). Decodes with the
existing `VideoReader`; the compositor recombines it in a shader. (Chrome's WebCodecs does
not reliably decode VP9 alpha.)

### 2.7 Stock manifest `story/stock/manifest.json`
`{items:[{id, shotId, provider, providerId, url, author, authorUrl, licence, file, w, h, durationSec?}]}` —
kept for attribution and takedowns.

---

## 3. Backend

### 3.1 Settings (`packages/core/settings.py`, `.env.example`, `docs/railway-deploy.md`)
`story_mode_enabled: bool=False`, `story_mode_allowlist: str=""`, `pexels_api_key`,
`pixabay_api_key`, `unsplash_access_key` (all `str|None`), `graphics_service_url`
(`http://noey-graphics.railway.internal:8080`), `graphics_service_token` (shared secret),
`story_understand_model`, `story_board_model`, `story_graphics_model`, `story_qa_model`
(defaults from `quality.py` tiers). Exposed to the client as `features.story` on the existing
`/auth/me` (or `/billing/plans`) payload.

### 3.2 Mode registration (no migration — `mode`/`stage`/`status` are plain strings)
- `videos_local.py:create_local_project` allow-list += `story` (gated by the flag/allow-list → 404 when off).
- `models/video_project.py`: `VIDEO_STATUS` += `waiting_user`; `PIPELINE_STAGES`/`STAGE_ORDER["story"]` =
  `imported → understood → boarded → produced → rendered`; `PAID_STAGES`.
- `packages/billing/resume.py:SERVER_STAGES` += the story stages; router `_STAGE_KIND`,
  `_reached_stage`, `_resting_status` (`waiting_user` is a resting status and restartable).
- `_WEB_FILE_ROOTS` += `story`, `broll`, `brand`.
- `plan_features.py`: `FOOTAGE_KINDS` += `story_understand`; footage cap = `SPEECH_FOOTAGE_SEC`
  for A-roll, b-roll counted separately (cap: 40 files, 10 min total b-roll video).
- `llm/usage.py:_TASK_BY_FEATURE` += `story_*` features.

### 3.3 Billing (`packages/billing/estimate.py`)
New `Kind`s + `MODE_PROFILES` entries, each `sized` from the request:
| kind | calls | inputs priced | output sizing |
|---|---|---|---|
| `story_understand` | STT + 1 | A-roll audio sec (STT) + A-roll video sec at 1 fps + b-roll video sec + photos×258 | thinking + 120×concepts + 40×b-roll files + 8×transcript words/10 |
| `story_board` | 1 per selected concept | transcript + index + concept | thinking + 220×expected shots (0.43 shots/s of target) |
| `story_revise` | 1 | storyboard + notes | thinking + 220×noted shots |
| `story_produce` | 1–4 | stock thumbs, graphic specs, QA frames | thinking + 2,500×custom graphics (cap: split into 2 calls above 20k) |
Starts: understand at wizard submit, board at concept pick, produce at approve — three
separate runs (each its own strict start gate; resume exempt). Output caps = model max;
`finish_reason=length` → `safety_cap`, no auto-retry (existing rule). Measure real numbers
in Phase 9 and update the constants in one commit.

### 3.4 Prompts + calls (`backend/packages/video/story/`)
One module per call; each = system prompt constants + `RESPONSE_SCHEMA` built from the
catalog + `async def run_*(…)` using `upload_gemini_file` / `gemini_video_block` /
`acompletion_stream_thinking` exactly like `dub_ai.generate_dub_edit_script_video`
(Files API, several files in one message, `finally: delete_gemini_files`).
- `understand.py` — inputs: A-roll proxy (fps 1), every b-roll proxy (fps 1) and photo, the
  word list as `[i] word (start)`, Scribe silence gaps, brief. Output: index + keep + concepts.
  Prompt rules: product-agnostic; keep = pick the best take per script line (Kitti dropped a
  whole first take and kept ~4 s of the first 77 s of raw — retake detection, not only silence
  removal), drop flubs, repeats and fillers, never reorder lines, never speed up. Code then
  trims every pause to 100–250 ms (measured on Kitti: median gap ~160 ms, longest 660 ms
  under a flash) with 50–100 ms padding per word edge; overall ~60–67 % of raw is removed on
  a scripted talking head.
- `storyboard.py` — inputs: concept, kept words, index (text only, no video re-upload),
  brand, style defaults (§3.5), catalog prose. Output: storyboard.
- `revise.py` — current storyboard + notes `{shotId: text}`; must return only the noted shots;
  code merges and re-validates.
- `stock.py` — HTTP clients (`httpx`, 10 s timeout, 3 results × query per provider,
  portrait first), then ONE vision call over all candidate thumbnails (labelled `shot/candidate`)
  → pick or `none`. Download picked originals (video ≤1080p file from the provider's file list)
  to `story/stock/`. No keys → skip silently.
- `graphics_code.py` — ONE call writes every `custom` graphic as a self-contained HTML document
  following the Graphics Contract (§4.2); output `{items:[{id, html}]}`; split into two calls
  when the estimate passes 40k output tokens.
- `graphics_qa.py` — ONE vision call over a contact sheet (3 frames per graphic: 10 %, 50 %, 90 %)
  → `{items:[{id, ok, problems[], fix}]}`; checks overflow, overlap with the safe area, Thai
  rendering (tone marks, cut words), contrast, invented numbers.
- `graphics_fix` — one call for failing items only; a graphic that fails twice falls back to
  the `text_card` template with the same text.
Style defaults (`style_defaults.py`, measured from Kitti v1, see §11): shots 0.8–3 s (median
~2.1 s), A-roll full-frame ≤35 % of time, every A-roll jump cut hidden under a cutaway or
`white_flash`/`settle`, super text 2–5 words rewritten (not verbatim) with one emphasised
keyword, a super on most shots, an SFX on every cut and super (~25–40 per 90 s), punch-ins on
climax words only (≤3 per minute), music bed −13 to −15 dB under voice.

### 3.5 Worker tasks (`services/worker/tasks.py`, registered in `WorkerSettings.functions`)
`story_understand_local`, `story_storyboard_local`, `story_revise_local`, `story_produce_local`
— all `@billed_task()`; produce chains its sub-steps inside one task with
`_release_connection` before each model call and `_finish_stage` checkpoints per sub-step
(`stock` → `graphics` → `qa`) so a `paused_quota` resume restarts at the sub-step, not at
the beginning. Each writes its JSON to `story/`, `_push_project_files`, updates the job, sets
the project to `waiting_user` (understand, board, revise) or `processing→produced`.

### 3.6 Routes (`services/api/routers/story.py`, mounted beside `videos_local`)
Same pattern as `analyze_video` (lock row → idempotency → refuse running → estimate →
`start_paid_run` → `_queue_job_row` → `_open_stage` → enqueue):
- `POST /videos/{uid}/story/understand` (multipart: A-roll WAVs, A-roll + b-roll proxies,
  photos ≤1600 px, brand files, manifest JSON)
- `POST /videos/{uid}/story/storyboard` `{conceptIds[] (1–2)}`
- `POST /videos/{uid}/story/revise` `{notes:{shotId:text}}` (≤40 shots, ≤500 chars each)
- `POST /videos/{uid}/story/approve` → enqueues produce
- `GET /videos/{uid}/story` → `{stage, concepts?, storyboard?, graphics?, stock?}`
- `PUT /videos/{uid}/story/storyboard` (user's manual edits from the player: super text, swap
  b-roll, delete shot — validated, no AI)
New `/admin` routes: none.

---

## 4. Noey Graphics service (`graphics/`, new Railway service)

### 4.1 Service
- Scaffold: `npm init -y` + `npm i playwright fastify` in `graphics/`, Dockerfile `FROM
  mcr.microsoft.com/playwright:<pinned digest>` (Chromium + Thai fonts: copy
  `backend/data/fonts/*` + Noto Sans Thai into `/usr/share/fonts`, `fc-cache`).
- `POST /render` `{html, durationSec, fps, width, height}` (bearer `GRAPHICS_SERVICE_TOKEN`)
  → `video/mp4` stacked-alpha; `POST /frames` `{html, times[]}` → PNGs (for QA).
- Per request: fresh browser context, `javaScriptEnabled`, viewport 1080×1920, transparent
  background, `route('**/*')` aborts everything except `data:` and the injected font/asset
  URLs, CSP meta `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src
  'unsafe-inline'; font-src data:`, 10 s wall limit for load, 200 ms per frame, 1 GB memory
  (container), max 15 s of graphic. No env secrets other than the token. Private network only
  (no public domain).
- Frame loop: for each frame `await page.evaluate(t => window.__noey.seek(t), t)` then
  `page.screenshot({omitBackground:true})` → ffmpeg (`-f image2pipe`) builds colour + alpha
  planes → `vstack` → H.264 CRF 18.
- Concurrency: 2 renders per instance (env), queue in memory, 429 when full (worker retries).

### 4.2 Graphics Contract (given to the model verbatim; tested in `graphics/test/contract.test.ts`)
- One HTML document, ≤60 KB, inline CSS/JS/SVG only, no external URLs, no `fetch`, no timers
  driving visuals — all motion is a pure function of time.
- Must define `window.__noey = { duration: <sec>, seek(t) { … } }`; `seek` must be idempotent
  and render the exact state at `t` (CSS animations allowed only via
  `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t*1000 })`).
- Canvas 1080×1920, transparent background, safe area 90 px sides / 220 px top / 380 px bottom
  (TikTok UI), fonts via `font-family: var(--noey-font)` (injected), colours via CSS variables
  `--noey-primary`, `--noey-accent`, `--noey-text` (injected from the brand kit).
- Numbers and words shown must come from the shot spec (validator re-checks the HTML text).

### 4.3 Templates (`graphics/templates/<id>.html` + `<id>.schema.json`)
Same contract, parameterised by `window.__params`. Built and tested in this service; the
storyboard picks a template + params → no model call. 18 templates (§2.1). Each has a
fixture params file and a golden contact sheet (`graphics/test/golden/<id>.png`, compared
with pixelmatch, 1 % tolerance).

---

## 5. Web client

### 5.1 Wizard + mode plumbing
- `lib/wizardState.ts`: `UiMode` += `story`; `backendMode('story') = 'story'`; gates: ≥1
  A-roll, 0–40 b-roll, brand kit optional; hidden unless `features.story`.
- `components/wizard/WizardStepFiles.tsx`: role per file (A-roll / b-roll, default by
  `has_audio` + speech detected later; user can flip); photo support (jpg/png/webp/heic→jpg
  via canvas); "Brand kit" drawer: logo, mascot, primary + accent colour, caption font from
  `CAPTION_FONTS`.
- `lib/projectFlow.ts`: `STORY_STEP_ORDER = importing → understanding → concepts → boarding →
  storyboard → producing → assets → matting → rendering → done`; `stepOrderFor('story')`;
  progress stages; `lib/modeLabel.ts` label.
- `lib/useProjectPipeline.ts`: new `runStory*` functions in a NEW file
  `lib/storyPipeline.ts` (do not grow the 3,347-line file further; call into it from the mode
  branches at the existing switch points ~52/1655/2065/2201/3034/3193).
- `lib/storyApi.ts`: typed client for §3.6 (reuses `pollJob`, `estimateUsage`, idempotency key).

### 5.2 Ingest additions (`engine/jobs/`)
- `ingest.ts`: accept photos (`kind: photo`), normalise to ≤1600 px WebP for AI + keep the
  original for render.
- `extractProxy.ts`: reuse for b-roll video (480p 12 fps). A-roll audio: existing
  `extractAudio.ts`.
- New `storyAssets.ts`: download `story/graphics/*`, `story/stock/*` to OPFS (resume-safe,
  checks sizes against the manifests).

### 5.3 Concept picker (`pages/story/ConceptPage.tsx`)
2–3 cards: title, hook (big), beats list, tone chip, est. length; select 1–2 → shows the
estimate → `POST /story/storyboard`. "ขอแนวใหม่" = re-run understand (billed, confirm dialog —
in-app modal, never `window.confirm`).

### 5.4 Storyboard player (`pages/story/StoryboardPage.tsx` + `components/story/*`)
Kitti parity + better:
- Horizontal shot strip (equal-width cards: index, tag, time, duration); keyboard ←/→, Space.
- Preview pane 9:16: still frame from the source proxy (A-roll or b-roll at `in`), layout
  drawn by the SAME compositor in "still mode" (§5.5) so the preview is the real look;
  super text rendered by the real caption code; plays the A-roll audio of the shot (decoded
  from the WAV, so sound works — Kitti's did not).
- Right panel per shot: VO line, super text (editable inline), layout / camera / transition /
  SFX chips (editable from the catalog), source file + range, swap b-roll (from index) or
  stock (from candidates), note box.
- Footer: "ส่งโน้ตให้ AI แก้" (notes → revise, only noted shots, estimate shown), "อนุมัติ
  แล้วสร้างคลิป" (approve → produce). Manual edits save via `PUT /story/storyboard`, free.

### 5.5 Compositor (`web/src/engine/story/`)
- `resolve.ts` — storyboard + transcript + keep → output timeline (pure, unit-tested).
- `scene.ts` — `sceneAt(t)` → ordered layers `{source, rect, transform, opacity, mask, filter}`
  for one output frame (pure, unit-tested: every catalog entry has a test at 3 times).
- `gl.ts` — WebGL2 on `OffscreenCanvas` 1080×1920: textured quads, transform matrix, stacked
  alpha shader, matte shader (person cut-out with 2 px feather), gaussian blur (2-pass,
  for `result_card` bg), colour matrix (`freeze_bw`), flash/whip/zoom-blur passes, crack
  overlay (procedural SVG rasterised once). Fallback when WebGL2 is missing: refuse the mode
  in `platform/capability.ts` (all supported desktop Chrome/Edge/Safari have it).
- `captions.ts` (story) — super text: 2-line layout, emphasis colour + 1.15× size, outline 4 px
  @1080, pop/typewriter/word_pop/keyword_bump, position by layout (A/B full 64 %, large
  cut-out 33 %, PiP 24 %, card 84 %) and pushed out of the face box. Reuses
  `ensureCaptionFont` and `Intl.Segmenter`.
- `render.ts` — `renderStory(projectDir, storyboard, signal)`: opens one `VideoReader` per
  source, walks output frames at 30 fps, draws via `gl.ts`, encodes through the existing
  `encodeVideo` → `final.mp4` (staged OPFS write). Registered as engine job `renderStory`
  in `engine/jobs/index.ts` + `sidecar.renderStory` + `platform/types.ts` (the type must
  exist on `typeof noey`, desktop stub throws "unsupported").
- Performance budget: ≥1× real time for a 90 s 1080p job on an M1/mid Windows laptop;
  decode ahead with one frame of lookahead per source; measure in Phase 9.

### 5.6 Person matte (`web/src/engine/story/matte.ts`)
- `@mediapipe/tasks-vision` ImageSegmenter (selfie segmenter, GPU delegate), model file
  self-hosted under `web/public/models/` (CSP: no third-party origins).
- Pass only over A-roll ranges used by `cutout_over_broll`/`pip_corner`/`shrink_to_pip`
  shots, at 15 fps, EMA temporal smoothing (α 0.6), stored as `story/matte/<clip>_<in>.mp4`
  (grayscale H.264 540×960) so re-renders skip it; compositor samples with bilinear
  upscaling + feather.
- Also emits a face/head box per frame (largest component bbox) → camera anchor + super text
  avoidance.

### 5.7 Audio (`web/src/engine/story/audio.ts`)
`OfflineAudioContext` 48 kHz: A-roll keep ranges (10 ms fades at each join), b-roll audio muted
unless `mute:false`, SFX (§5.8) at resolved times, music bed at `bedDb` with sidechain-style
duck (envelope from voice RMS, −`duckDb`, 80 ms attack / 300 ms release), then loudness
normalise to −14 LUFS integrated, true peak −1 dBTP (`loudness.ts`: BS.1770-4 K-weighting +
gating, unit-tested against reference tones).

### 5.8 SFX synth (`web/src/engine/story/sfx.ts`)
Each catalog SFX = deterministic Web Audio recipe (noise bursts + filters + envelopes +
oscillators): whoosh (band-passed noise sweep), pop (sine blip 600→200 Hz, 40 ms), click,
tick, typing (randomised click train, seeded), thud/boom (low sine + noise, 120–250 ms),
impact, ding/bell (additive partials), chime_reveal (rising arpeggio), crack (filtered noise
crackle), kaching, stamp, rewind (pitch-swept noise), riser. Seeded by shot id → same render
twice = same audio. Each recipe has a test asserting duration, peak and spectral centroid
range. A licensed pack can replace recipes later via the same `kind` keys.

### 5.9 Result page
`pages/story/StoryResultPage.tsx`: player + the same shot strip; per-shot notes → revise
(only those shots) → produce re-runs only shots whose graphic/stock changed (manifest diff)
→ re-render. Download MP4. Attribution list for stock in a collapsible "เครดิตภาพ" section.

---

## 6. Security & safety checklist (verify each in tests)
1. AI-written HTML runs ONLY in Noey Graphics, never in the user's browser or our origin;
   the storyboard player shows rendered PNG frames, not the HTML.
2. Graphics service: private network, bearer token, no secrets in env, all network routes
   aborted, size/time/memory caps; a test HTML that tries `fetch`, `<img src=https://…>`,
   `while(true)` and 1 GB allocation must fail closed.
3. Stock: only the three APIs; never other web images; store attribution.
4. No invented numbers: validator on storyboard + rendered HTML text.
5. Uploads: existing size/type checks; b-roll counts toward storage quota.
6. Vendor names never appear in UI strings (grep test exists — extend its glob to `story/`).

---

## 7. Build order (phases, each ends with its gate green and a commit)

| Phase | Deliverable | Gate (all must pass) |
|---|---|---|
| P0 | Branch, settings, flag, catalog + schemas (py + ts), contract test | `pytest tests/test_story_schema.py`, `vitest src/lib/story` |
| P1 | Noey Graphics service + 18 templates + contract + sandbox tests; deployed to Railway (private) | `graphics: npm test` (golden sheets, sandbox escapes fail), a smoke render from the worker host |
| P2 | Compositor (`resolve`, `scene`, `gl`, captions, render job) on hand-written storyboard fixtures (no AI) | vitest pure tests; one Playwright run rendering `fixtures/story/demo.json` → contact sheet reviewed; render speed ≥1× |
| P3 | Audio: SFX synth, ducking, loudness | vitest (LUFS reference tones ±0.5 LU, SFX recipes) |
| P4 | Person matte + face box + cut-out layouts | Playwright one run on a fixture clip → contact sheet; matte coverage test |
| P5 | Backend mode registration, billing kinds, routes, tasks with fake LLM fixtures (`packages/llm/fake.py` canned story answers) | pytest: routes (flag off → 404), estimate, billed tasks + resume per sub-step, `test_every_ai_task_is_billed_and_registered_by_name` updated, admin security walk |
| P6 | Real prompts: understand, storyboard, revise, stock, graphics code, QA, fix | pytest call-site tests (monkeypatched gateway), validator tests incl. invented-number rejection |
| P7 | Web UI: wizard, concept picker, storyboard player, result page, pipeline | vitest (flow, api, gates), `npm run typecheck && npm run lint && npm run build`; one Playwright happy path with `LOADTEST_FAKE_AI=1` locally |
| P8 | Hardening: resume after `paused_quota` at every stage, cancel, refresh mid-job, network loss on asset download, re-render idempotency | pytest + vitest for each case |
| P9 | Live eval on the 3 owner fixtures (§0 ★1), ≥3 runs each (memory: cut-prompt eval method), contact sheets + MP4s in `docs/story-eval/`; tune prompts/estimates; record measured tokens, call count, wall time, render speed | owner reviews the eval doc |
| P10 | Merge to `main` with flag off, deploy, watch logs; enable for the allow-list only | deploy green, smoke on production with the owner's account |

Rules during the run: test as you go (repo rule 6); Playwright only in P2/P4/P7 single runs;
run the full backend + web suites before every merge; commit per phase with English messages;
check `origin/main..main` and alembic heads before pushing (other sessions push to main);
update this file's checklist and `CLAUDE.md`/`AGENTS.md` code map at the end (new
`packages/video/story/`, `graphics/`, `web/src/engine/story/`).

---

## 8. Test inventory (new files)
Backend: `tests/test_story_schema.py`, `test_story_validate.py`, `test_story_estimate.py`,
`test_story_routes.py`, `test_story_tasks.py` (billing, resume, pause per sub-step),
`test_story_prompts.py` (call shape: files in one message, schema enums from catalog),
`test_stock_clients.py` (httpx mocked; no key → skip), `test_graphics_client.py`.
Graphics: `test/contract.test.ts`, `test/sandbox.test.ts`, `test/templates.test.ts` (golden).
Web: `lib/story/*.test.ts` (types/catalog parity, api), `engine/story/resolve.test.ts`,
`scene.test.ts`, `captions.test.ts` (Thai grapheme typewriter, line split, emphasis),
`audio.test.ts`, `loudness.test.ts`, `sfx.test.ts`, `storyPipeline.test.ts`.
E2E (Playwright, minimal): `e2e/story-happy-path.spec.ts` (fake AI), `e2e/story-render.spec.ts`
(fixture storyboard → contact sheet).

## 9. Fake AI for local + tests
Extend `packages/llm/fake.py:build_answer` with canned, VALID answers for the four story
schemas (routed by a schema `title` field), built from `tests/fixtures/story/*.json`, so the
whole flow runs end to end with `LOADTEST_FAKE_AI=1` and no vendor cost.

## 10. Known risks
- **Render speed in the browser** with WebGL + several decoders: if <1× real time on a mid
  laptop, lower matte fps and decode b-roll at 720p; measure in P2.
- **Model taste**: storyboard quality needs P9 iterations; budget 3 prompt rounds.
- **Gemini output for graphics code** may be long: the split-into-two-calls rule keeps each
  answer under the 65,536 cap; templates should cover most shots so custom code stays rare.
- **Stock relevance for Thai content** is thin; fallback order keeps the clip complete.
- **MediaPipe matte quality** on busy backgrounds: feather + EMA; accept for v1.
- **Remotion history** (§0 item 6): read the reason before P1 if the owner allows.

## 11. Style reference (measured from Kitti's own result clip, 90.8 s)
39 visual segments, median 2.1 s; A-roll full 28 %, b-roll 30 %, motion graphics 19 %, result
card 12 %, cut-out over b-roll 10 %; super text = rewritten 2–5-word summaries, white + lime
`#EAFF07` keyword, thick black outline, pops in 0–0.3 s before the word; ~40 SFX events (whoosh
on cuts, pop on supers, impact on reveals, ticks/ka-ching on count-ups, key clicks on typing,
stamp + 7 px shake on badges); 6 white flashes (3 frames) hiding jump cuts; 2 punch-ins
(+13–15 % in 0.2 s) on climax words; music bed 13–15 dB under voice with ~3 dB duck; −14.1 LUFS.

---

## Checklist (the executing session ticks these)
- [ ] §0 owner inputs collected (★1, ★2 at minimum)
- [ ] P0 contracts
- [ ] P1 graphics service + templates
- [ ] P2 compositor
- [ ] P3 audio
- [ ] P4 matte + layouts
- [ ] P5 backend plumbing + billing
- [ ] P6 prompts
- [ ] P7 web UI
- [ ] P8 hardening
- [ ] P9 live eval
- [ ] P10 merge + deploy (flag off) + allow-list
