# Web port — progress

Status file for the browser build of the video editor. **Read this first** when
resuming: do the first gate that is not PASS.

Plan: `C:\Users\AMD\.claude\plans\lively-wishing-dolphin.md`

Rules (from the plan):
- Update this file the moment a gate passes, before starting the next one.
- A gate that fails gets its real symptom + `file:line` written here, so the next
  round does not re-derive it.
- Everything lives on disk. No git (project rule).

| # | Gate | Status | Notes |
|---|------|--------|-------|
| 0 | This file | PASS | created 2026-09-08 |
| 1 | Scaffold + capability gate | PASS | 266 tests, 0 type errors, 0 lint errors; gate passes in Chrome |
| 2 | Auth + CORS | PASS | real login against :8000, session survives reload |
| 3 | OPFS + service worker + probe + ingest | PASS | probe matches ffprobe; SW does 206 Range + real 404; `<video>` seeks |
| 4 | extract-proxy + AI analyze + server purge | PASS | real Gemini cut in ~45 s; server keeps no proxy afterwards |
| 5 | render-silent (the core) | PASS | 6.8 s out for 6.8 s of segments; one resolution; no black frames |
| 6 | Timeline editor + filmstrip + save | PASS | filmstrip draws; duplicate → save → 6.8 s → 8.3 s; 0 long frames |
| 7 | Voiceover + render-final | PASS* | engine verified end to end; the UI button is blocked on the server's AI credit |
| 8 | Music + mix-music | PASS | volume linear, offset exact, removal deletes; 46 s → 0.3 s via packet copy |
| 9 | Speech modes (scenes + highlights) | PASS | all three modes rendered from real transcripts |
| 10 | Shot swap + stash/restore | PASS | 7 shots swapped, re-rendered, reverted byte-identical |
| 11 | Export + bundles | PASS | byte-exact single file; 28-file zip; CapCut bundle opens with a correct manifest |
| 12 | Sweep: vitest + typecheck + lint | PASS | 283 tests, 0 type errors, 0 lint errors |
| 15 | Server-backed project files (open from any browser) | PASS | project opens in a fresh profile at 0.01 MB and renders there |
| 14 | Any input file (server transcode fallback) | PASS | HEVC in → MP4 out; server holds it 5.5 s |
| 13 | Responsive UI for every screen size | PASS | no overflow at 390–1920; desktop layout untouched |

## Log

### 2026-09-08

**Gate 1 — scaffold.** Copied `desktop/app/src/renderer` verbatim (141 files), added
`src/platform/` (the `window.noey` implementation), `src/engine/` (the WebCodecs
job surface) and `public/media-sw.js`. Deleted the phone/LAN/remote features
outright rather than stubbing them: `PhoneMenu`, `ReceiveFromPhoneModal`,
`SendToPhoneModal`, `lib/remoteStatus.ts`, and the copy that referenced them.
Type errors went 51 → 0.

Three things worth remembering:
- `platform` is typed `string`, not `'web'`. The shared UI compares it against
  `'darwin'` / `'win32'`; the literal type made those a compile error.
- The service worker MUST live in `public/` (so it is served at `/media-sw.js`).
  From `/src/sw/` it can only claim `/src/sw/` and every `/media/...` request
  404s. It is plain JS for the same reason — nothing may compile it.
- The PowerShell copy turned every file CRLF, which is 12,890 prettier warnings.
  Normalised to LF.

**Gate 2 — auth.** Added `CORS_EXTRA_ORIGINS=http://localhost:5174` to
`backend/.env` (settings already supported it; the API needs a restart to pick
it up). One real bug: `httpClient.ts` passes `jsonBody` ALREADY SERIALISED, and
the web `apiFetch` was stringifying it again — every login 422'd. The desktop
proxy passes it through, so the web one now does too.

Test accounts are `admin@noey.local` / `ChangeMe123!` (not `admin@example.com`).

**Gate 3 — storage and ingest.** `src/engine/media.ts` wraps mediabunny; the
jobs live in `src/engine/jobs/`. Measured in Chrome against a real 12 s
1080×1920 clip:

| | |
|---|---|
| probe | 6 ms, `12.006s / 1080×1920 / 30fps / audio` — matches ffprobe exactly |
| ingest | 77 ms → `normalized/norm_000.mp4` + `upload_sources.json` |
| media route | GET 200 (6,140,688 bytes, `video/mp4`, `no-store`) |
| Range probe | **206**, `bytes 0-0/6140688` — what `usePreviewFile.exists()` needs |
| missing file | **404**, not a throw |
| `<video>` | loads 12.006 s, and **seeks to 8 s** |

One real bug, found only by running the UI: `create()` announced a change, so
the job host picked the project up between `create()` and the `update()` that
follows it — the pipeline booted on a row with `step:'imported'` and no clips
and went straight to the AI call ("clips: List should have at least 1 item").
The desktop announces on nothing but the phone remote; now neither does this.

**Gate 4 — proxy, AI, and the server purge.** End to end in the browser:
ingest → extract-proxy → `analyze-video` → a real Gemini edit script in ~45 s.

The purge is the bigger half. Uploaded media was landing in
`data/video_outputs/<uid>/{proxy,audio,music}` and staying there forever —
**2.93 GB across 234 files**, the oldest two months old. Now:

- `storage.purge_uploaded_media(uid, subdirs)` + `s3.delete_output_subdir` —
  both copies go, because every task starts with `pull_project_files` and would
  otherwise restore what was just deleted.
- Wired into analyze (`proxy`), speech (`audio`), re-edit (`ai_reedit`+`proxy`),
  effects (`effects`), and the music route (right after beat detection).
- **Success path only.** A retry must not have to re-upload, and for speech it
  must not pay for transcription twice.
- The allow-list is the guard: passing `clips` or `final.mp4` raises. Seven
  tests cover it, including one that pins `video_outputs/` as the real
  location — an earlier draft checked `video_uploads/`, which the upload routes
  never touch, so it would have passed while the files stayed.
- Unblocking that meant a desktop change: AI re-edit used to reuse whatever
  proxies analyze had left on the server. It now re-uploads them (it has them
  locally, and analyze re-sends the same files anyway). Client, route and task
  all touched; desktop suite still 374 green.

Verified after the fix: a project cut at 04:02 has `edit_script.json` and no
`proxy/` directory at all.

Still on disk: the 2.93 GB of historical media from before this existed. Not
deleted — that is the owner's call.

**Gate 5 — render-silent.** The dub flow ran to "คลิปพร้อม" in 82 s in real
Chrome. Measured on the output, in the page:

| | |
|---|---|
| `final_silent.mp4` | 200, plays, **6.8 s** for 6.8 s of nominal segments |
| resolution | 1080×1920, one shape for the whole file |
| frames at 0.3 / 3.4 / 6.5 s | avg luma 138 / 138 / 139 — real picture, not the green-frame class |
| `script.txt` | 200, 183 bytes, grouped by voiceover line |
| `dub_bundle.zip` | 200, 3.39 MB |
| `clipDurationsSec` | `[2, 2, 1.5, 1.3]` — 4 segments, sums to the duration |

There is no concat step, so the mixed-resolution bug the desktop needed
`conform_video` for cannot happen: every frame is drawn on one canvas of one
size.

**A harness lesson worth keeping:** each `playwright.launch()` gets a throwaway
profile, and **OPFS does not survive it** — `storage_state` carries cookies and
localStorage only. A verification script launched separately saw zero projects.
Everything now goes through `scratchpad/drive_web.py`, which uses
`launch_persistent_context` against a fixed profile dir, so a later script sees
what an earlier one rendered.

**Gate 6 — the editor.** Opened it on the rendered project: the preview plays,
the scene lane draws four filmstrip strips (every pixel of every strip is real
picture, not the blank canvas a failed decode leaves), and the right panel binds
to the selected scene.

Duplicating scene 3 and pressing บันทึกและเรนเดอร์ re-rendered in 44 s:

| | before | after |
|---|---|---|
| segments | 4 | 5 |
| duration | 6.8 s | **8.3 s**, exactly the new nominal |
| `clipDurationsSec` | `[2, 2, 1.5, 1.3]` | `[2, 2, 1.5, 1.5, 1.3]` |
| bytes | 3,384,418 | 4,158,799 |

Two real bugs, both found by driving the UI:

- **Features that do not exist here were still on screen** — เอฟเฟกต์การซูม,
  ให้ AI แก้ให้, ดูดเข้าจังหวะ, and two เปิดโฟลเดอร์โปรเจกต์ buttons. Gate 1
  had checked the *tabs*, not these. `lib/platformFeatures.ts` now names each
  capability once and the four call sites hide rather than disable: a disabled
  control has to explain what would enable it, and here nothing would.
- **Alt+wheel zoom fought the scroll.** React registers its root `wheel`
  listener as PASSIVE, so `preventDefault()` inside the synthetic `onWheel`
  was ignored — Chrome logged "Unable to preventDefault inside passive event
  listener" on every notch and the viewport scrolled underneath the zoom, so
  the anchored time landed in the wrong place. Now bound natively with
  `{passive: false}`. Measured after: 40 → 160 → 4 px/s across 20 notches,
  **0 frames over 50 ms** out of 405, p95 10 ms, no console errors.
  (The desktop build has the same passive-listener bug; not touched — it is
  out of this plan's scope.)

**Gate 7 — voiceover and render-final.** Recording works against a fake mic:
three lines, `พากย์แล้ว 3 จาก 3 ประโยค`, and เรนเดอร์วิดีโอ enables itself.

`render-final` was then run on that real recording. Measured on the output:

| | |
|---|---|
| cuts | 5, from the edit script's own segments |
| duration | 7.509 s for 7.5 s of nominal cuts |
| resolution | 1080×1920 |
| **audio track** | AAC stereo, 7.509 s, RMS 0.087 — the recording is on it, not silence |
| `final_bundle.zip` | 200, 3.84 MB |
| `clips/clip_001.mp4` | 200, 661 KB |
| `clipDurationsSec` | `[1.3, 1.8, 1.6, 1.6, 1.2]` |
| progress stages | `cut` → `mux` → `bundle` |

Three things changed to get there:

- **`clips/clip_NNN.mp4` was never being written.** The desktop cuts those
  files first and concatenates them; this build has no concat, so they had no
  reason to exist — except that `dub_bundle.zip`, `capcut_bundle.zip` and the
  export list all read `clips/`. They now come out of the SAME frame pass via
  `media.ts:openClipWriter` + `EncodeOptions.mirror`, rather than a second
  decode of every source. Each clip's own clock is re-based to zero: a first
  frame at 4.2 s reads as four seconds of nothing in someone else's editor.
- **`cancel()` aborted a controller nobody read.** `engine/index.ts` created an
  `AbortController` per job but never put its signal in the job spec, while
  every job reads `job.signal` — so หยุดงาน let the encode run to completion.
- The cut loop is now one file, `engine/cutRender.ts`, shared by render-silent
  and render-final instead of duplicated.

**Blocked, not broken:** pressing เรนเดอร์วิดีโอ goes through the server's
`plan-dub`, which failed with `เครดิต AI หมด` — the backend's model credit is
exhausted. The engine half above was therefore driven directly with the real
recorded voiceover and the real edit script.

That failure also exposed a backend bug worth keeping fixed: `plan-dub` is the
only route that calls a model synchronously, and it caught `ValueError` only.
A provider error escaped the ASGI app, uvicorn dropped the connection, and the
browser reported it as **a missing CORS header** — the UI showed "HTTP 0" for
what was really "เครดิต AI หมด". It now returns 502 with the sanitised message
(`videos_local.py:plan_dub`).

**Gate 8 — music.** Attaching a track in the editor copies it into the project
store (`music/music_test.mp3`) and does NOT upload it: the beat-detection call
was still running on this build, which would have sent the user's music to the
server for a grid nothing here can use (the snap control is hidden). Now gated
on `canSnapToBeat` — `useProjectPipeline.ts:603`.

Then `mix-music` was driven four ways and the audio measured off the result:

| | duration | RMS 0–2 s | RMS 3–5 s |
|---|---|---|---|
| `final_silent.mp4` | 8.3 s | *no audio track at all* | — |
| volume 0.25 | 8.32 s | 0.0074 | 0.0074 |
| volume 1.0 | 8.32 s | **0.0296** | 0.0298 |
| volume 1.0, offset 3 s | 8.32 s | **0** | 0.0298 |
| music removed | — | file is **404** | — |

0.0296 / 0.0074 = 4.0 — the gain is linear, the offset silences exactly the
first three seconds, and clearing the track deletes the mixed file rather than
leaving the preview playing a bed the editor no longer shows.

**One real performance fix.** Swapping an audio track was re-encoding the whole
picture: 46 s for an 8 s clip, and a generation of quality lost on every nudge
of the volume slider. `media.ts:remuxWithAudio` now copies the encoded video
packets across (`EncodedPacketSink` → `EncodedVideoPacketSource`), which is
what the desktop's `-c:v copy` does. Same run: **0.3 s**, byte-identical audio
measurements, and the result still decodes and seeks (1080×1920, luma 138/139/139
at 0.3 / 4.2 / 7.9 s). The re-encode stays as the fallback for a file whose
packets cannot be copied.

**Gate 9 — the speech modes.** Three jobs written: `extract-audio`,
`render-timeline`, `render-highlights`. `render-timeline` is the shared body;
`render-highlights` calls it once per highlight, exactly as the desktop does.

*A note on the test fixture.* The short clip used for gates 1–8 has **no
speech** (mean −43 dB, music only), so the server correctly refused it —
"คลิปนี้ไม่มีเสียงพูดให้ตัด". These modes cannot be tested without speech, so
`scratchpad/speech_test.mp4` and `speech_long.mp4` were built: Windows SAPI
narration muxed onto real footage. Deterministic, free, and it exercises the
real transcription path.

**talking_head / render-timeline, end to end and measured:**

| | |
|---|---|
| `extract-audio` | `audio/audio_000.wav`, 12.01 s, **16 kHz mono pcm_s16le** — the name the backend validates |
| peak normalise | source −21.5 dB → WAV −8.5 dB, the headroom `loudnorm TP=-1.5` keeps |
| transcription | real, 9 cuts planned, 3.2 s of silence removed |
| output | 29.739 s vs 29.739 s of nominal cuts (quantised sum 29.733) |
| audio | 29.739 s of the ORIGINAL sound, RMS 0.070, peak 0.695 |
| frames | luma 117/132/118/113/120 across five points — no black stretches |
| `captions/subtitles.srt` | 825 B, real transcript text at real times |
| `capcut_bundle.zip` | 46 MB · `clips/clip_001.mp4` 2.4 MB |

**speech_scenes** (ตัดฉากเด่น · ใช้เสียงในคลิป), 1:53 source:
transcribing → selecting → rendering → done in 310 s. 1 scene, nominal 53.82 s,
output **53.845 s** at 1080×1920 with 53.845 s of original audio (RMS 0.064);
`final.mp4`, `captions/subtitles.srt` and `capcut_bundle.zip` all 200.

**speech_highlights** (ตัดไฮไลต์จากคลิปยาว, 30 s target), same source: done in
253 s. One highlight, `h01` "6-Month Review: 3 Everyday Bags" — 17.088 s of
video with 17.088 s of original audio (RMS 0.068), `h01.srt` beside it carrying
the real transcript. Two absences are the point of the mode and both hold:
**`final.mp4` is 404** and **`clips/` is 404** — a highlight is self-contained,
and anything looking for a single final must find nothing rather than a
lookalike.

Line endings: every file touched by a Python edit came back CRLF (`write_text`
translates on Windows) — 9,499 prettier warnings. Normalised, and the service
worker is now exempt from the TypeScript-only lint rules, since it is plain JS
on purpose. **eslint: 0 errors. vitest: 266 passed.**

Known cost, not yet addressed: a 53.8 s render took 266 s (~6 fps). Every cut is
encoded twice — once into the joined output and once into its own
`clips/clip_NNN.mp4`. Correct, but worth measuring before gate 12.

**Gate 10 — shot swap.** The 12 s clip produced **no** alternates (correct: the
model returns none when there is nothing to offer), so this was run against the
1:53 clip, where Gemini returned alternates on 7 of 27 shots.

| | before | after swap | after revert |
|---|---|---|---|
| first three windows | 4.2–6.8, 7.2–8.7, 11.4–12.9 | **1.5–3.5, 8.8–10.2**, 11.4–12.9 | 4.2–6.8, 7.2–8.7, 11.4–12.9 |
| nominal | 42.2 s | **40.2 s** | 42.2 s |
| `final_silent.mp4` | 35,732,516 B | 34,136,356 B | **35,732,516 B** |
| `previousRender` | absent | present | absent |

The revert is a stash restore, not a re-render: it completed instantly and gave
back the byte-identical earlier file. The modal itself renders real thumbnails
through the service worker and reads exactly as the desktop's does — "ช็อตนี้เอาอันไหน",
"AI เลือกไว้" / "อีกมุมหนึ่ง", "ทำคลิปใหม่".

**Gate 11 — export.** The modal lists what actually exists and prices it
honestly: คลิปที่ตัดเสร็จ 34.1 MB, คลิปแยกทีละฉาก (27 ไฟล์) 34.4 MB,
ไฟล์ทั้งชุด 68.5 MB, and ไฟล์คำบรรยาย greyed out as "โปรเจกต์นี้ยังไม่มีไฟล์นี้".

| | |
|---|---|
| one file | `final.mp4` downloaded at **91,003,429 B** — byte-for-byte the stored file |
| many files | 28 selected (102.8 MB) → `speech_long.zip`, 28 entries, CRC clean |
| `capcut_bundle.zip` | 180 MB, **35 entries**, CRC clean: `final.mp4` + 31 scene clips + `captions/subtitles.srt` + `manifest.json` + `README.txt` |
| manifest | correct `project_uid`, `mode: talking_head`, `output: final.mp4`, Scene 1–31 |

**And the render got 13× faster.** Measuring before optimising was the right
call: the per-scene mirror encode, the obvious suspect, cost only **7%** (244 s
→ 263 s). The real cost was pulling frames one at a time — `CanvasSink.getCanvas`
is a random access, so every frame of a render re-walked its GOP. Feeding the
whole run of a cut's timestamps to the decoder in one pass
(`canvasesAtTimestamps`, wrapped as `VideoReader.framesAt`) took the same 27-cut,
1,266-frame render from **263 s to 19.3 s** — and the output is byte-identical
(35,732,516 B both ways), which is the strongest proof available that not one
frame changed.

**Gate 12 — the sweep.** 283 vitest tests (21 copied files + 2 new), `tsc
--noEmit` clean, eslint 0 errors. The 8 remaining warnings are
`react-hooks/exhaustive-deps` notes the desktop build carries too.

Writing the first tests for the engine found a **real port gap**. The TS
`normalizeDubEditScript` stopped one step short of the Python one: it never ran
`annotate_dub_script_output_times`, so no segment carried `outputIn`/`outputOut`
and `script.txt` printed SOURCE timestamps under headings that mean OUTPUT
times — pointing the reader at the wrong moment of a file they are not
watching. Ported, and the format now matches `write_dub_script_txt` exactly:

```
[Line 1 | 0.0s → 2.6s]
[Line 2 | 2.6s → 7.1s | 3 cuts]
[Line 3 | 7.1s → 10.1s | 2 cuts]
```

The same tests caught `normalizeDubEditScript` **rewriting the caller's
object** — sorting and clamping the very edit script the editor was displaying.
It copies now.

**Gate 13 — responsive.** The rule throughout: **at 1024px and above nothing
changes.** The desktop layout is the design, and every breakpoint added here
only lets it survive a narrower window.

What was actually broken at 390px, measured before touching anything: the 208px
nav rail took half the screen, the page title wrapped one glyph per line, the
primary action sat off the right edge, and the card grid was clipped.

| | |
|---|---|
| nav rail | below `md` the SAME rail slides in over the page, opened by a hamburger in the title bar; tapping the page or navigating closes it |
| page header | wraps its action under the title below `sm`; 34px title → 26px |
| project grid | cards go full-width instead of a fixed 325 |
| project detail | preview above the actions below `lg`, one scrolling column |
| wizard | 3 outcome cards → 1; file and review panes stack |
| editor | inspector under the stage below `lg`; the tool row scrolls sideways rather than reflowing |
| voiceover | line list under the preview below `lg` |
| studio / settings | side panels stack; the 300px card goes fluid |
| dialogs | the handoff's exact widths become a **maximum**: `calc(100vw - 32px)` |

Buttons and segmented controls now carry `whitespace-nowrap` — at 390px the
labels were breaking mid-phrase ("แยก / ที่หัว / เล่น" on three rows), which
reads as three controls.

Verified by measurement, not by eye: an overflow audit across **projects,
wizard, detail, editor, studio, settings × 1920 / 1366 / 1024 / 768 / 390** —
zero elements past the viewport, zero horizontal page scroll, on all thirty.
The drawer was then driven for real at 390px: closed −208 → open 0 → tap-away
−208, navigation closes it, widening puts the rail back in its column and takes
the hamburger away, and narrowing again does **not** reopen it.

That last one was a real bug in the first attempt. The drawer now records
*where* it was opened — which screen, at which width — and resets during render
rather than in an effect. An effect chasing it paints the drawer once before
closing it, which is exactly what `react-hooks/set-state-in-effect` was flagging.

Finally, the app was driven end to end at 390×844: opened a project, duplicated
a scene in the editor and saved. 28 → 29 segments, `final_silent.mp4`
35,732,516 → 38,416,577 B, rendered in 60 s.

## Where this landed

Every gate passes. Against the desktop app:

- **Identical**: 108 of 136 shared UI files are byte-for-byte the desktop's, and
  most of the rest differ only by an import path. Every screen, every string.
- **Removed on purpose**: the phone/LAN features (there is no LAN here), zoom
  effects and AI re-edit (they need `render-effects` / `render-ai-preview`,
  not yet written), and beat snapping (a server-side analysis of a music file
  this build deliberately never uploads). All hidden, never disabled-with-a-hint.
- **Different by necessity**: "โฟลเดอร์เก็บงาน" is "ที่เก็บงาน" — the browser
  owns where the data lives; the login subtitle and two wizard hints no longer
  point at a phone.
- **Better**: no concat step, so the mixed-resolution class of bug cannot
  happen; captions are drawn in the render pass instead of a second re-encode;
  a music swap copies the video packets instead of re-encoding them.


## Gate 14 — accepting any file (2026-09-08)

A real 324 MB iPhone clip was refused with a thumbnail that never appeared and
`ไฟล์นี้เปิดในเบราว์เซอร์ไม่ได้`. Measured cause: the file is **HEVC (hvc1),
1080×1920, 6:27**, and this Chrome cannot decode HEVC at all —
`VideoDecoder.isConfigSupported('hvc1…')` false, `<video>.canPlayType` empty.
Not a container problem: converting `.mov` to `.mp4` changes nothing when the
codec inside is the part the browser cannot read.

**Three bugs found on the way**

- **The error blamed the wrong thing.** `transcode.ts:52` is the SECOND catch —
  the file had opened fine and something later failed, yet every failure in
  that block reported "the browser cannot open this file" and sent people off
  to re-export a clip that was never the problem. It reports the real reason now.
- **The clip row span forever.** Handed HEVC, `<video>` fires NEITHER
  `loadedmetadata` NOR `error` — it just never settles, so the probe promise
  never resolved and the row sat on "กำลังอ่านข้อมูลคลิป…" with no way out.
  The engine now answers first (**4 ms**, and it is the only one that knows the
  codec); the element has a 4 s deadline behind it.
- **The refusal came three screens late** — after the wizard was completed and
  a job started. The codec is known at pick time, so the row says so there.

**What the ingest does now** — everything ends up as H.264 in an MP4, three
ways, cheapest first:

| input | path | measured |
|---|---|---|
| H.264 in `.mov`/`.mkv` | copy the packets into MP4 | **29 ms**, 3,016,739 → 3,012,437 B, pictures bit-identical |
| decodable, other codec | decode → encode at the SOURCE's resolution | sequential decode, same trick as the 13× render win |
| **not decodable** | **the server's ffmpeg** | see below |

**The server exception.** The owner's rule has been that video never reaches
the server, and it still holds for everything the browser can open. But a
browser cannot decode HEVC, every recent iPhone records it by default, and
refusing those clips means refusing most phone footage. So one narrow exception:

- only clips the client FAILED to open are sent — H.264 never is;
- the server converts the codec and nothing else. No cut, no AI, no render;
- the scratch is under the USER's id, not a project — a conversion is
  stateless, and tying it to a project row would force the row to exist before
  the import that creates it;
- both files are deleted the moment the client has the bytes.

Cost, measured on the owner's own 6:27 clip: **2 cores 84 s · 4 cores 79 s ·
8 cores 53 s · 24 cores 30 s** (4.6–12.9× realtime), and the output is **61%
smaller** than the HEVC source. `libx264 veryfast` beat hardware `h264_amf`
(30 s vs 81 s) and produced a smaller file — no GPU needed on the server.

Verified end to end in the owner's own Chrome with a real HEVC clip:

```
07:50:10.671  transcode_queued        8,740,758 B in
              ffmpeg                  3,359 ms
07:50:15.300  transcode_for_web_done  11,561,574 B out
07:50:16.229  transcode_dropped
```
`data/video_transcode/`: **0 files, 0.00 MB**. The server held it for 5.5 s.
The clip landed as `normalized/norm_000.mp4`, 1080×1920, 12.167 s, audio intact.

Desktop untouched and still green: 374 vitest, typecheck clean, 53 sidecar
tests. Backend 512 passed (the same 2 pre-existing `.env`-reading failures).


## Gate 15 — the server holds the files (web only)

Decided 2026-09-08, reversing the web build's original "nothing reaches the
server" rule for STORAGE while keeping it for WORK. The reason is the one
problem OPFS cannot solve: it is per browser profile, so a project made in one
browser does not exist in another, and Safari discards it after 7 unused days.

**What stays true.** Rendering, cutting, captions and the mix all still run on
the user's machine. The server stores bytes and converts codecs; it does not
edit. The desktop build is untouched and keeps everything local.

**The model.** The server is the home of a web project's files; OPFS becomes a
cache in front of it.

| | |
|---|---|
| uploaded | `project.json`, `normalized/*` (the sources), and every render output |
| when | after ingest, after each render, and on every project.json change |
| reading elsewhere | the service worker falls back to the server with Range passthrough, so preview and the editor start without waiting for a whole file |
| the project list | OPFS merged with the server's manifest |

**Order of work**

1. `PUT/GET/DELETE /videos/{uid}/files/{path}` + a manifest endpoint.
2. Upload after ingest and after each render.
3. Service-worker fallback to the server on an OPFS miss (Range passthrough).
4. Project list merged from the server manifest.
5. Verified by opening the same project in a second browser profile.


**Gate 15 — done, and verified across three browser profiles.**

| | |
|---|---|
| upload after a render | 8 files, **36.3 MB in 13 s** |
| a profile that had never seen the project | the project appears, local store **0.01 MB** |
| playing it there | 206 with `bytes 0-0/6184646`, loads 8.2 s / 1080×1920, **seeks to 3 s** |
| opening the editor there | filmstrip draws real pixels; the source is pulled once and cached (**11.63 MB**) |
| **rendering there** | duplicate a scene 3 → 4, re-render in **9 s**, `final_silent.mp4` 6,947,237 B |

**Two real bugs found by running it**

- **`Content-Range` was invisible.** The service worker forwards a `<video>`
  Range request to the API and hands the reply back. Range-response headers
  are not CORS-safelisted, so the player received a clean 206 whose
  `Content-Range` it could not read — and refused to load the file at all.
  Fixed with `expose_headers` on the CORS middleware.
- **Engine jobs read OPFS directly**, so on a restored project the filmstrip
  and every render found nothing and failed, even though the preview played
  (that goes through the worker). `blobForPath` now falls back to the media URL
  on a miss and **caches the result back into the store**, so a source is
  pulled once and every later pass is local.

**What the server does and does not do.** It stores files and converts codecs.
The cut, the captions, the mix and the render still all run on the user's
machine, and the desktop build is untouched: 374 vitest, typecheck clean,
53 sidecar tests. Backend 525 passed (the same 2 pre-existing `.env`-reading
failures). Web: 283 tests, 0 type errors, 0 lint errors.

Not yet addressed: two browsers editing the SAME project at once. Uploads are
last-writer-wins by file, which is right for one person moving between
machines and wrong for two people at once.


## Gate 7 closed, and the mobile question answered (2026-09-08)

**`plan-dub` → render-final, driven through the UI.** Three lines recorded
against a fake mic, then เรนเดอร์วิดีโอ:

```
waiting_vo → planning (the server's model call) → final_rendering → done   9 s
final.mp4  200, 3,265,437 B, 6.101 s, 1080×1920
audio      6.101 s, RMS 0.081 — the recording is on it
plan       3 cuts, 6.1 s nominal
```
This was the last piece still blocked on the exhausted provider credit; it runs
on Gemini now.

**Wake Lock, kept.** Every job holds `navigator.wakeLock` while it runs
(`lib/wakeLock.ts`, reference counted, re-taken when the page returns to the
foreground). On a phone the screen dimming is the first step towards the tab
being suspended, and a suspended tab stops encoding mid-render.

**The Worker migration: proposed, measured, and DROPPED.** I suggested it; the
numbers do not support it.

| the claim | what was measured |
|---|---|
| the render janks the UI | during a real render: **0 frames over 50 ms** out of 300, p95 = worst = 10 ms |
| a background tab is throttled | the loop is promise-driven — no `setTimeout`, no rAF — so the clamps do not apply |
| it would survive an iOS app switch | it would not: workers are suspended with the page |

The encode already happens off the main thread inside WebCodecs; the main
thread only draws a canvas and hands the frame over. Moving the orchestration
would add a large seam for no measured gain.

**Two bugs found while checking the owner's screenshot**

- **The service worker's state was lost to a race.** It keeps the server origin,
  token and uid map in an OPFS file (a worker is terminated when idle and
  restarts with a blank scope). Each message did its own read-modify-write, and
  the page posts one message per project in a loop — so two projects both read
  the same old state and the last write won. One project's media then 404'd
  with nothing to say why. Updates are chained now.
- **`เปิดโฟลเดอร์โปรเจกต์` was still on the project card** and in its overflow
  menu — two sites the earlier pass missed. Gated like the rest; an audit
  script now confirms every `openFolder` call sits behind `canOpenFolder`.

The clip-row codec hint was removed at the owner's request.

**And the thumbnail turned out to be possible after all.** I had said it was
not: a browser that cannot decode a frame cannot draw one. True — but it can
still DEMUX what it cannot decode, which is exactly what makes `remuxToMp4`
work on HEVC. So the frame does not have to be decoded here.

`media.ts:firstFrameClip` cuts the first KEY PACKET into a tiny self-contained
MP4 — a real container, so the far end needs no knowledge of hvcC, annex-B or
parameter sets — and only that is sent to `POST /videos/poster`, which decodes
one frame with ffmpeg and returns a JPEG. Nothing is stored: the temp dir is
removed in the same request.

Measured on a 1080×1920 HEVC clip:

| | |
|---|---|
| extract, in the browser | **48 KB from 8.74 MB in 11 ms** — 1/179th of the file |
| round trip | **115 ms** |
| result | a real 144×256 JPEG (avg luma 126, range 1–250 — a picture, not a grey box) |

The `<video>` element is still tried first and still gets its 4 s deadline
(HEVC makes it settle neither way); the server is the fallback, and the film
icon remains the fallback to the fallback.

---

## Gate 16 — pre-deploy audit sweep (2026-09-08)

A 12-agent audit (6 dimensions × find + adversarially verify) over `web/` and
`backend/`, then every confirmed finding fixed and tested. **57 findings
confirmed real of 62 claimed**; 5 were rejected by the verify pass.

Test state after the sweep: backend `pytest` **562 passed** (the 2 long-standing
`.env`-dependent `test_llm_config` failures unchanged), web `vitest` **431
passed**, web `tsc` clean, web `eslint` **0 errors**, desktop `typecheck` +
**374 tests** untouched and green.

### Business-secret leaks (the owner's first priority)

Every one of these was reachable by a user, and each is now closed and pinned
by a test.

- **`GET /settings` needed no credentials at all** and returned the exact model
  id plus which vendors had keys. A browser address bar was enough. Now
  admin-only and out of the schema. `GET /prompts` (the literal instruction
  text sent to the model) and `GET /runs` (raw model output and provider error
  text) were equally open — both authenticated at the router.
- **`/openapi.json` and `/docs` were public**, and route docstrings name the
  providers. Off unless `API_DOCS_ENABLED=true`.
- **`sanitize_technical_error` fell through to `return text`** — correct for the
  app's own Thai errors, a leak for any provider message its mapping table had
  not met. A vendor-name backstop now scrubs the fall-through, and
  `format_exception_message` runs every HTTPException detail through it too.
  One mapped message literally read "เซิร์ฟเวอร์ AI (Anthropic)".
- **The chat system prompt told the model it was Claude** — a `<claude_behavior>`
  tag and third-person "Claude" in the refusal block, so a user could simply
  ask. Rewritten as "the assistant", with an explicit instruction never to name
  what is behind it.
- `src/lib/noLeaks.test.ts` now walks every string in every `.ts`/`.tsx` under
  `web/src` (comments excluded) and fails on a vendor name.

### Security

- **A fresh production database seeded a publicly known admin login.**
  `ADMIN_PASSWORD` defaults to a string in this repo and the seed runs on every
  API boot. `assert_production_secrets()` now refuses to start on a non-local
  database when `JWT_SECRET`, `POSTGRES_PASSWORD` **or** `ADMIN_PASSWORD` is
  still a placeholder.
- Alembic ran at IMPORT time — a test collection migrated the database. Moved
  into `lifespan`.

### Deploy (nothing could actually be deployed before this)

- **`web/` had no build or serve path at all**, and `docker-compose`'s `web`
  service still built the legacy `frontend/` dashboard. Added `web/Dockerfile`
  (full `npm ci` — `--omit=dev` would have broken it, since react and react-dom
  were in devDependencies) and `web/nginx.conf`, which serves `/media-sw.js`
  from the root path with `no-store`. Compose repointed at `./web`.
- **The CSP hard-coded the API origin**, so any other `VITE_BACKEND_URL` was
  blocked before a request left the page — reported to the user as
  "เชื่อมต่อ server ไม่ได้". A Vite plugin now templates it; verified by
  building with `VITE_BACKEND_URL=https://api.example.test` and reading the
  emitted `connect-src`.
- **`data_root()` was hard-coded to `backend/data`** — inside the image, with no
  volume mounted, so every redeploy took the users' footage. Added `DATA_DIR`,
  and a shared `noey_data` volume in compose.
- **The manifest and the storage quota read local disk only**, so on an
  ephemeral or multi-host deploy a fresh browser saw an empty project and the
  plan quota read 0 used. Both now merge S3.
- **The HEVC conversion required api and worker to share a filesystem** — which
  Railway's own docs tell you not to assume. Scratch files now go through S3
  when it is configured.
- `PUT /videos/{uid}/files` re-uploaded the project's whole output tree per
  file: syncing N files cost N²/2 object writes. One file, one object now.
- `S3_ENDPOINT_URL` was part of the enablement test, silently disabling storage
  on plain AWS. Removed from the test, still passed through for R2.
- `.env.example`, `backend/.env.production` and `docs/railway-deploy.md` were
  all rewritten — the first two still pointed `LLM_MODEL` at Anthropic, and the
  deploy doc described a `scheduler` service that does not exist.

### Correctness

- **The service worker's token was captured once at login and never refreshed**,
  so every server-backed media read died 30 minutes into a tab's life — and the
  worker reported it as 404, which the UI showed as "ไม่พบไฟล์". The refreshed
  token now reaches React state (and the worker), and 401 is passed through as
  401.
- **`projectSync`, `serverTranscode` and the storage panel all used a bare
  `fetch`** and never refreshed. Consolidated on `lib/authedFetch.ts`.
- **A 507 (quota full) was discarded twice**, so a sync stopped halfway with
  nothing on screen. The server's own message — which names the numbers — is
  what the user sees now.
- **The ingest transcode discarded the source audio.** Every clip a browser
  cannot decode goes through that path, so an iPhone recording lost its sound
  before the user ever saw a timeline.
- **Several engine jobs read the local store directly** and dead-ended on a
  project opened in another browser: the music bed was silently dropped from
  `final.mp4`, `mix-music` did nothing at all, and the export checklist came up
  empty on a project showing a finished preview. Single-file reads go through
  `blobForPath`; directory listings through a new `listProjectDir`, backed by a
  server manifest cached into the store.
- **The wizard persisted in-memory `picked://` ids into `project.json`** — a
  reload during an import (minutes, for a clip that goes through a server
  conversion) stranded the project permanently, and "ลองใหม่" could not recover
  it. Files are staged into the store before anything is written down.
- **Ingest deleted the shared staging root**, so in the wizard's
  one-project-per-file mode the first import to finish deleted every other
  import's sources. Staging is namespaced per project.
- **Only the encoder read `job.signal`** — หยุดงาน left a long import running to
  completion and blocked the project's queue behind work the UI said had
  stopped.
- **The 10-second undo after deleting was dead** whenever the delete started
  from the detail page: navigating away unmounted the hook and committed the
  delete immediately, while the toast counted down over a no-op.
- `render-final` sized the audio mix from unquantised cut lengths, so the audio
  and video tracks disagreed by the accumulated per-cut rounding.
- The storage panel counted every `video_projects` row the account had ever
  had — 162 of them, for someone looking at two. It counts projects that still
  hold files now (152 here: the rest are desktop-app runs from June onward that
  really do occupy the 5.7 GB).

### Honesty of the UI

Copy that promised things this build does not do: the login page still said
"คลิปอยู่ในเครื่องคุณ" after the server became the home of a project's files;
the wizard offered "ตัดตามจังหวะ" (on by default) for beat-sync that never
runs; the progress screen promised "ใส่การซูม"; a stalled queue told a browser
user to run `python -m services.worker`; an export failure pointed at a log
folder that does not exist in a browser; the microphone error sent people to OS
settings when the fix is the site permission; and "เรนเดอร์แบบไม่มีเสียงพากย์?"
confirmed a render that never started. All rewritten to match what happens.

The "สไตล์การซูม" library was a dead end — a paid AI distillation nothing on
this build can consume — and is hidden. The zoom editor subtree (~3,000 lines,
unreachable) is lazy-loaded out of the initial chunk; `sidecar.render`,
`inboxUrlFor`, `lib/propGroups.ts` and eight phone/LAN type declarations with
no implementation were deleted. Four comments describing a Python sidecar,
ffmpeg and Electron IPC — none of which exist here — were rewritten.

### Verified in a real browser

Chrome, against the local API: the session restored, both projects listed with
previews, `/settings` `/prompts` `/runs` `/videos/storage` all 401 anonymously
and `/openapi.json` `/docs` 404, the storage panel reads the server, the
library shows only cut styles, and the export checklist — previously empty —
listed final.mp4 (3.1 MB) and the bundle (9.1 MB) and downloaded successfully.
Console clean.

---

## Gate 17 — the missing-call sweep (2026-09-08, after the first deploy)

Gate 16 shipped, and within the hour production produced a bug it had not
caught: **`syncToServer` was called on the `highlight` branch of the silent
render and not on the `waiting_vo` branch beside it.** A dub project rests at
`waiting_vo` until someone records a voiceover — days, or never — so not one of
its files, `project.json` included, ever reached the server. Opening the
account in a second browser showed an empty workspace: the exact failure the
whole server-storage design exists to prevent.

Nothing threw. Nothing logged. Every unit test around it passed. The defect was
an **absent call on one branch of an if/else**, and Gate 16's audit had verified
the code that EXISTS.

So this sweep used a different method — the **completeness matrix**: enumerate
the full set of {states, events, branches, call sites} on one axis and the
required side effects on the other, then check every cell. 14 agents (7 audit
dimensions + 7 adversarial verifiers, Opus 5 at high effort). **76 findings
confirmed real of 78 claimed.** All 76 fixed.

Test state: web `tsc` clean · **459 vitest** · `eslint` 0 errors · backend
`ruff` clean · **575 pytest** (the 2 long-standing `.env` failures unchanged) ·
desktop untouched, `typecheck` + **374 tests** green.

### The three blockers

- **"ให้ AI ตัดใหม่" could never run on a restored project.** `extract-proxy`
  read `upload_sources.json` with a bare OPFS call while the very next line in
  the same loop used `blobForPath`. A restored project has only `project.json`
  locally, so the read returned null and the job threw "ยังไม่ได้นำเข้าคลิป" —
  which `fail()` then persisted, flipping a *finished* project to an error
  state in every browser. Now read through the server, with `project.clips` as
  a second fallback for projects synced before the manifest was uploadable.
- **Deleting any web project raised `TypeError` and deleted nothing.** The web
  build writes `upload_sources.json` as `{id, file, original}` objects; the
  server-render chain writes plain strings, and `_collect_project_dirs` called
  `pathlib.Path(dict)`. The exception escaped before the S3 prefix and the DB
  row were touched, and `restoreMissingProjects` pulled the project back on the
  next load — a project that could not be deleted, ever.
- **`plan-dub` returned the raiser's literal text.** One arm used `str(exc)`
  while the arm four lines below already used `format_exception_message`. The
  string it forwarded named the vendor, `fail()` persisted it to `project.json`
  AND the server row, and the project card rendered it. Both halves fixed: the
  arm now uses the funnel, and the two `raise ValueError` sites are Thai.

### Same class as the shipped bug — eight more found

`syncToServer` never ran on: attaching, editing or removing music; every
voiceover take; `fail()`; `revertRecut`. And `syncToServer('import')` was
*structurally dead* on a first run — the server row was created inside
`runAnalyze`, so at import time there was no target and the call returned
immediately. An import that then failed left nothing on the server at all. The
row is created at the end of the import now.

Two consequences of the same shape: removing a music track deleted the local
mix but not the server's, and the preview probe kept resolving to the server
copy — so the user heard the music they had just removed, in the same browser.
And four synced roots (`music`, `voiceover`, `captions`, `fx`) were never
swept, so a track swap orphaned the old object forever against the plan quota.

### Lifecycle

`bootstrapPipeline` had no `try/catch`: a throw out of `runImport` or a render
resume left the project on a busy step with no error, no retry and nothing that
would re-fire the effect — a permanently spinning card. หยุดงาน during the AI
upload was ignored entirely (no token check between the upload and the render),
so the whole billed run completed and the card flipped back to busy. `stop()`
parked every run at `imported`, discarding the checkpoint a *reload* would have
used — so stopping a final render hid the voiceover button and `retry()` bought
a second AI cut over an approved script. `retry()` now resumes from a stored
timeline or edit script before it re-buys anything.

### Engine

Every encode buffered the finished MP4 in RAM (plus mediabunny's in-memory
faststart copy); `openStagedWrite` existed for exactly this and had zero call
sites. Renders stream to OPFS now — verified in a real browser: a 3-cut render
produced a 4.65 MB file that `<video>` loads (6.10 s, 1080×1920) and **seeks**
into at 4.00 s, with the service worker answering `206`.

`transcodeToH264` decoded the source's whole PCM into RAM — ~384 kB per second,
~2.7 GB at the 2 h cap — and a blanket `.catch(() => null)` made an allocation
failure, a decode failure and a genuinely silent clip indistinguishable; a
later stage then reported "คลิปนี้ไม่มีเสียง" about footage the user could hear
in their own player. It now encodes video-only to a staged file and **copies
the donor's audio packets** under it (measured: 12.01 s in, 12.01 s out, audio
carried across, temp file cleaned up), decoding PCM only as a bounded fallback.

`renderTimeline`'s audio catch swallowed fetch and decode failures, writing a
silent `final.mp4` for the modes built on the original audio and then pushing it
over the good server copy. A null frame ended the whole render quietly while
`durationSec` still described the full cut list. `filmstrip` swallowed
`AbortError`, so หยุดงาน was a no-op there and the job still resolved `done`.

### Sessions

A failed refresh ended nothing — the user sat on a workspace where every call
failed with an English server detail. Two paths (the settings page, the style
library) refreshed tokens and dropped them, leaving React state and the service
worker on the dead token. And the store is per ORIGIN: signing in as a second
account showed the first account's projects, playable and exportable.

### Garbage

A daily `sweep_housekeeping` cron now retires abandoned transcode scratch (disk
AND S3, 24 h TTL — the deleter was the browser, so a closed tab meant forever)
and job rows past 30 days. `plan_talking_local` was the one speech task of
three that never purged its uploaded WAVs. `DELETE /files/{rel}` skipped the S3
delete whenever the API host had no local copy — which on Railway is the normal
case, so swept clips stayed in the bucket, in the manifest and in the quota.
A task finishing after its project was deleted re-created the whole tree with
no row to attribute it to.

### Restore

`GET /videos` was capped at 50 rows with no pagination while the restore walks
the whole account, so older projects were silently invisible in a fresh
browser. The service worker's uid→remoteUid map was posted *after* the first
media requests were already in flight, and kept an entry for every deleted
project forever.

### Verified live, not just compiled

Against the local API with the new backend: a real 3-cut render (183 frames =
6.1 s × 30 fps exactly), the per-scene clips written by the same pass with the
previous run's `clip_004` correctly gone, a real `pushProjectFiles` (6 files,
18.6 MB, no `.part` uploaded), `extract-proxy` succeeding with
`upload_sources.json` deliberately deleted from the store, and the delete
manifest fix exercised against all three payload shapes.

---

## Gate 18 — Safari, and every screen at every width (2026-09-09)

Two reports from the live build, one after the other.

### iPhone: `c.createWritable is not a function`

The owner reached step 3 of the wizard on an iPhone, pressed เริ่มตัดต่อ, and
got that error on screen. iOS Safari implements OPFS but NOT
`FileSystemFileHandle.createWritable()` — and every write in the app went
through that one call (`fs.ts` × 4). The capability gate had waved the phone
through because it only asked whether `navigator.storage.getDirectory` existed,
never whether a write would work.

Safari's own write API is `createSyncAccessHandle()`, which the spec allows
only inside a Worker. So `opfsWriteWorker.ts` is a message pump over the sync
API and `opfsWrite.ts` routes to it when `createWritable` is missing; Chrome
and Firefox keep the fast path untouched. The gate now probes by WRITING, not
by feature-sniffing.

Only the file write moved threads. Decode, encode, captions, the mix — all
still on the user's own device, and the phone had already proved it can encode:
the gate's probe is a real H.264 encode of real frames (`capability.ts:62`),
which is how it got as far as the wizard in the first place.

**A worse bug fell out of testing it.** The first probe froze the tab outright.
A sync access handle is an EXCLUSIVE lock held until `close()`, so an
interrupted write leaves one open and re-opening that path waits for ever —
with no error, no log, nothing. For a Safari user that reads as: a render
fails once, they press render again, the app hangs permanently. `begin` now
closes any handle still open on that path first. Two more found the same way:
the message id and the file id were the same value (a reply could resolve the
wrong promise), and an aborted stream never released its handle.

Verified in a real browser on the worker path: whole-file write round-trips;
**out-of-order positional writes land correctly** (`[9,9,9,9]@8` then
`[1..8]@0` reads back in order — this is what the muxer does when it patches
moov after the media, and getting it wrong corrupts every MP4); re-opening a
locked path recovers instead of hanging; no `.part` left behind. The production
build emits `opfsWriteWorker-*.js` as its own chunk.

### "responsive แต่ละหน้า เหมือนยังไม่สมบูรณ์ ... บางหน้ามันไม่สวยเลย"

Correct, and my first answer was too quick — I grepped for fixed widths, found
three, and called it nearly done. A 16-agent sweep (8 surfaces × audit +
adversarial verify, Opus 5 at high effort) found **108 findings, 74 distinct
after dedup**, across four severities.

Nearly all of them were two shapes:

- an unprefixed `w-[NNNpx]` in a row that cannot wrap;
- `w-full shrink-0` beside a `flex-1` sibling — which by the flexbox spec lays
  that sibling out at **exactly 0px**, because the scaled shrink factors sum to
  zero. Wizard step 2 rendered every one of its controls at zero width, twenty
  pixels past the right edge, at every width below `lg`.

The root cause behind several: `#root { height: 100vh }` with
`body { overflow: hidden }`. `vh` is the LARGE viewport, so a 390×844 iPhone
laid 844px into ~745px of visible area — and since every scroller is an inner
pane, no gesture retracts the toolbar. The bottom ~100px was permanently lost,
taking the wizard's ถัดไป, the recorder's controls and every dialog footer with
it. Now `dvh` with a `vh` fallback, `viewport-fit=cover`, and
`env(safe-area-inset-bottom)`.

Fixed, worst first: the Dialog footer (every confirm in the app), Tabs, the
Segmented rails, the Progress and RunningJobBar step rails (which gave the
whole project list a horizontal scrollbar for as long as a job ran),
VideoModal's 320px playlist rail (a 9:16 clip rendered **20px wide** beside its
own playlist at 390), JobProgressPage's 300px sidebar (progress column starved
to ~2px), ShotSwapReview's four 9:16 cards at ~54px each, CaptionPanel,
VoiceoverPage (stacked with `overflow-hidden`, so the record button was
off-screen and unreachable), EffectsStudioPage, the TimelineEditor's toolbar
and inspector, and the rest.

Touch and iOS: Switch (20×36) and Checkbox (18×18) get 44px tap targets via a
`before:` pseudo-element, so nothing moves on screen; Tooltip wraps and opens
on TAP (a disabled control cannot take focus and a phone has no hover, so every
"why is this greyed out" reason was previously unreachable); the nav drawer no
longer paints over its own toggle; Input and Textarea are 16px on a phone,
because below that Safari zooms the layout viewport on focus and never zooms
back.

### Measured, not reasoned

An iframe harness loaded the real app at **360 / 390 / 430 / 768 / 834 / 1024 /
1280 / 1440** and clicked through seven routes at each, reading
`documentElement.scrollWidth - clientWidth` and naming the widest offending
element. **Zero horizontal overflow, every route, every width.**

`responsive.test.ts` keeps it there: no unprefixed fixed width ≥340px in any
reachable screen, no `w-full shrink-0` without a breakpoint width, `dvh` +
safe-area on `#root`, `viewport-fit=cover` in the HTML, and a 16px floor on
form fields.

Test state: web `tsc` clean · **542 vitest** · `eslint` 0 errors · production
build clean. Backend and desktop untouched by this gate.
