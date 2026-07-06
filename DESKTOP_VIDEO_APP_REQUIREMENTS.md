# Desktop Video-Edit App — Requirements (Draft)

Status: **implemented for both modes** (2026-07-03) — dub_first AND
talking_head run fully local-render (only frame JPEGs / speech WAVs upload;
LLM + Whisper stay server-side via `packages/llm` / Modal), manual timeline
editor, web dashboard local-awareness, and Windows packaging (PyInstaller
sidecar + bundled ffmpeg + NSIS installer). Both modes verified end-to-end
against the real backend + real LLM/Whisper with real creator clips.
See `desktop/README.md` for flows and commands.
Decisions resolved at implementation: **Electron** (electron-vite, React + TS
— no Rust toolchain on the dev machine ruled out Tauri) and **Python sidecar**
(spawned process reusing `backend/packages/video`, JSON-lines protocol)
rather than porting render logic to JS.
Remaining: mac build (needs a Mac), auto-update, code signing.

## 1. Problem

The AI video-edit pipeline (`packages/video/*` — transcribe, timeline planning, scene
extraction, caption/overlay render, ffmpeg encode) currently runs server-side via the
arq `ingest_video` worker task. ffmpeg encoding is CPU-heavy; with multiple concurrent
users on one shared server, render jobs will contend for CPU and degrade or crash the
service. Centralizing render capacity does not scale cheaply.

## 2. Decision

Split the video-edit feature out of the web app into a **standalone desktop
application** with its own UI. The main web dashboard (Island, tables, revenue, chat,
prompt-cron) stays a browser app as-is and is unaffected.

The desktop app:

- Ships for **Windows and macOS** (Tauri or Electron — cross-platform packaging).
- Contains its own UI: import clip(s), timeline editor, preview, render.
- Authenticates independently against the existing `/auth/login` endpoint using the
  same username/password as the web app. **No shared session** with the browser —
  each app holds its own JWT.
- Performs **ffmpeg rendering locally** on the user's machine. The central server
  never runs ffmpeg for this feature again.
- Stores raw clips and rendered output **on local disk only** — no S3/R2 upload of
  video bytes. `packages/video/s3.py` and `backend/data/video_uploads` /
  `video_outputs` are not used by this flow.
- Still calls the backend for anything that requires the shared server: login,
  AI analysis (Claude Vision style-profile, highlight/cut planning via
  `packages/llm`), and video-project metadata (title, status, generated
  timeline/edit-script JSON) so the web dashboard can list/track projects.

## 3. What moves where

| Concern | Today (server) | New (desktop app) |
|---|---|---|
| ffmpeg encode/render | `services/worker/tasks.py` (`ingest_video`), arq queue | Local, inside desktop app process |
| Raw clip storage | `backend/data/video_uploads/<project_uid>/` (+ optional S3 sync) | User's local disk |
| Rendered output storage | `backend/data/video_outputs/<project_uid>/` (+ optional S3 sync) | User's local disk |
| Transcription (Whisper) | `services/whisper` / `services/modal_whisper` | Unchanged — stays server-side (cloud) |
| AI cut/highlight planning, style profile (Vision) | `packages/video/timeline.py`, `style_profile.py` via `packages/llm` | Unchanged — desktop app calls backend, backend calls LLM gateway |
| Auth | Shared browser session | Independent login, own JWT, same credentials |
| Project metadata / status | `models/video_project.py` | Unchanged — still source of truth, synced from desktop app |

## 4. Backend changes required

- `routers/videos.py` / `services/worker/tasks.py`: introduce a **local-render mode**
  distinct from the existing server-render mode (keep server-render working for any
  path that still needs it, e.g. talking-head mode if it stays server-side — TBD).
  In local-render mode the backend:
  - Issues AI planning results (timeline/edit-script JSON) to the desktop app on
    request, instead of driving ffmpeg itself.
  - Accepts a "render complete" report from the desktop app to update
    `VideoProject.status` (no file upload attached).
- No changes needed to `/auth/login` — desktop app reuses it as-is.
- `packages/video/s3.py`, `storage.py`: not used by the local-render path; leave
  intact for any remaining server-render use.

## 5. Desktop app scope

- Reuse the existing frontend slice conceptually (`VideoPage.tsx`, `ImportModal.tsx`,
  `VideoTimelineEditor.tsx`) as the UI reference — exact tech (React inside
  Tauri/Electron vs. native rewrite) TBD at implementation time.
- Bundle ffmpeg binary per platform (Windows / macOS arm64 / macOS intel).
- Reuse `packages/video/*` render logic — requires a decision on runtime: run the
  existing Python modules as a bundled sidecar process (PyInstaller), or port the
  render logic to the app's native language. TBD.
- Local storage layout for clips/outputs (equivalent of today's
  `backend/data/video_uploads` / `video_outputs`, but under a user data dir).

## 6. Cross-platform caveats

- ffmpeg itself is cross-platform; only the bundled binary differs per OS.
- `face_tracker.py`: verify its dependency (e.g. dlib/opencv) has working wheels on
  macOS (including Apple Silicon), not just Windows.
- If Whisper is ever run locally instead of via the cloud worker, CUDA (Windows) vs.
  Metal (macOS) support diverges — out of scope for now since transcription stays
  server-side.

## 7. Known trade-offs / open questions

- Web dashboard loses the ability to preview/play video (file never reaches the
  server). Acceptable unless a thumbnail-sync step is added later.
- If the user doesn't have the desktop app open, video projects can't be rendered —
  purely on-demand, no background queue on the user's machine (no "headless
  companion" mode was chosen; the app itself must be running).
- Auth duplication (two independent login sessions) is accepted — no session-sharing
  work required.
- Talking-head mode (if it doesn't need ffmpeg-heavy rendering) may or may not need to
  move to the desktop app — needs a decision when scoping implementation.

## 8. Explicitly out of scope for this change

- Rewriting the main web dashboard as a desktop app (Option A, rejected).
- A headless/tray "render companion" with no UI (Option B, rejected in favor of a
  full desktop app since the user has to download something either way).
- S3/R2 storage for video files in the new flow.
