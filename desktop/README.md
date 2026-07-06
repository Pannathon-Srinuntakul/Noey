# Noey Video Edit — Desktop App

Standalone desktop app for the AI video-edit feature. See
`../DESKTOP_VIDEO_APP_REQUIREMENTS.md` for the full requirements and rationale.
Fully isolated from `backend/` and `frontend/` — nothing in this directory
modifies them (the sidecar only *imports* backend render helpers read-only).

## Layout

- `app/` — Electron + React + TypeScript (electron-vite). UI, backend API
  client (own JWT via `/auth/login` — no session sharing with the web app),
  encrypted token store (Electron `safeStorage`), and the sidecar bridge.
- `sidecar/` — Python render engine spawned by the Electron main process.
  Reuses `backend/packages/video` (added to `sys.path` by
  `sidecar/bootstrap.py`; override location with `NOEY_BACKEND_DIR`).
  Speaks JSON-lines on stdout: `ping`, `probe FILE`, `render --job FILE`.
  All logging goes to stderr so stdout stays protocol-clean.

## Commands

```bash
# Desktop app (from desktop/app)
npm run dev          # dev with HMR (opens the Electron window)
npm run test         # Vitest unit tests
npm run typecheck    # tsc main + renderer
npm run lint         # ESLint
npm run build        # typecheck + production bundles in out/
npm run build:win    # package Windows installer
npm run build:mac    # package macOS app

# Sidecar (from desktop/sidecar; uses the same Python env as backend/)
python -m sidecar ping
python -m sidecar probe path/to/clip.mp4
python -m sidecar render --job job.json
python -m pytest tests/
```

## Environment overrides (Electron main)

- `NOEY_PYTHON` — python executable used to spawn the sidecar (default `python`).
- `NOEY_SIDECAR_DIR` — sidecar package dir (default: repo-relative in dev,
  `resources/sidecar` when packaged).
- `NOEY_BACKEND_DIR` — where the sidecar finds `packages/` (default: repo
  `backend/` in dev).

## Modes

Two modes, picked per project at the import step:

- **dub_first** — AI writes the script + picks scenes from frames; you record
  a voiceover over the silent cut. (flow below)
- **talking_head** — silence-cut + repeated-take removal on a clip where you
  speak to camera (original audio kept). Flow: sidecar `extract-audio`
  (mono-16kHz loudnorm WAVs, same as the server) → upload WAVs to
  `POST /videos/{uid}/transcribe-audio` → arq `plan_talking_local` runs
  Whisper (Modal) + the planning passes (`packages/video/whisper_client.py`
  + `plan_core.py`) → desktop fetches `GET /videos/{uid}/local-timeline` →
  sidecar `render-timeline` (trim/concat + SRT + CapCut bundle via
  `packages/video/render_common.py`) → `final.mp4` + `capcut_bundle.zip`.
  Duration option: keep all speech, or AI highlight to ~N seconds.

## Dub-first flow (implemented end-to-end)

1. **Import** — pick clips → sidecar `ingest` copies to
   `userData/projects/<uid>/normalized/` (10-min cap enforced, same as server).
2. **Analyze** — sidecar `extract-frames` (same sampling as the server
   pipeline) → JPEGs upload to `POST /videos/{uid}/analyze-frames` → arq
   `analyze_dub_local` runs Claude Vision on the server → desktop polls
   `GET /jobs/{id}` (live thinking shown) → fetches the edit script.
3. **Silent render** — sidecar `render-silent` (shared
   `packages/video/dub_render.py` cores) → `final_silent.mp4` + `script.txt`
   + `dub_bundle.zip`; server status → `waiting_vo`.
4. **Voiceover** — user records externally, picks the audio file; probe
   measures duration; `POST /videos/{uid}/plan-dub` (sync LLM) returns the
   timeline.
5. **Final render** — sidecar `render-final` (trim/concat + VO mux) →
   `final.mp4`; server status → `done`.
6. **Manual edit** — TimelineEditor (ported from
   `frontend/src/hud/VideoTimelineEditor.tsx`, IO seam swapped in
   `lib/editorApi.ts`): pre-VO edits rewrite the edit script (TS port of
   `dub_segments_from_edit_cuts`, fixture-tested vs Python) and re-render
   silent; post-VO edits rewrite the planned timeline and re-render final.
   Sources stream over the privileged `media://` protocol (Range-capable,
   path-traversal-guarded).

## Packaging

- `npm run prepare:resources` — PyInstaller-freezes the sidecar
  (`../sidecar/sidecar.spec`, onedir, LLM stack excluded), stages
  `backend/packages/{core,video}` as plain .py data, downloads + caches
  ffmpeg/ffprobe for the current platform.
- `npm run build:win` / `build:mac` — prepare + electron-builder installer.
  extraResources: `sidecar/` (frozen exe), `backend/` (packages data),
  `ffmpeg/`. Main process wires `NOEY_BACKEND_DIR` + `FFMPEG_PATH` when
  packaged.
- Windows installer is a **full wizard** (assisted NSIS, per-machine):
  license accept → install-path chooser (default
  `C:\Program Files\noey-video-edit`) → UAC elevation → finish page with
  "Run app" + "Create Desktop shortcut" checkboxes. Start Menu shortcut
  always created. Config: `electron-builder.yml` nsis block +
  `build/installer.nsh` (custom finish page) + `build/license.txt`.
- Uninstaller: removes only the app's own install dir; a safety guard in
  `build/installer.nsh` (`customUnInit`) aborts if the resolved install
  path is suspiciously short (drive root) or doesn't contain the app exe
  (tampered registry). Note: NSIS resolves the real install location from
  the registry, so a copied-elsewhere uninstaller still uninstalls the real
  install (standard Windows behavior) — the guard only blocks unsafe/corrupt
  locations.
- Uninstall keeps user project data (`%APPDATA%\noey-video-edit`) by default
  (`deleteAppDataOnUninstall` false). The uninstaller shows a custom page
  after the welcome page with a **bold, unchecked** "DELETE ALL PROJECT DATA
  PERMANENTLY" checkbox; ticking it triggers an extra Yes/No confirmation
  (defaults to No) before data is removed. The deletion target is
  **hard-coded** to `$APPDATA\noey-video-edit` — never derived from INSTDIR
  or the registry — and passes 4 guards (drive-letter absolute, length ≥ 30,
  path ends with `\noey-video-edit`, dir exists) before any `RMDir`.
  Verified via a standalone NSIS harness: every dangerous path (`C:\Windows`,
  `C:\Program Files`, short/root paths, UNC, `...\..\Windows` traversal) is
  rejected; only the real appdata path is allowed. Silent uninstall (`/S`)
  skips the page entirely, so data is always kept in unattended mode.
- The finish-page desktop shortcut (created on the all-users desktop when
  ticked) is removed by the uninstaller too (`customUnInstall`).
- macOS: DMG drag-to-`/Applications` is the platform-standard install (no
  wizard/path concept); uninstall = move app to Trash; project data lives
  in `~/Library/Application Support/noey-video-edit`. Artifacts must be
  built on a Mac (PyInstaller can't cross-compile).

## E2E verified (2026-07-03)

Both modes ran headless end-to-end against the real backend + real LLM/Whisper
with a real creator clip (scripts under the session scratchpad): dub_first
(Vision edit script → silent → VO → final with audio) and talking_head
(Modal Whisper → timeline → local render with SRT + CapCut bundle). Web
dashboard lists local projects with the "ตัดต่อบนเครื่อง" badge and hides
server-file buttons; desktop delete also removes the server record.

## Not built yet

Auto-update, thumbnail sync back to the web dashboard, code
signing/notarization, macOS build (needs a Mac: `npm run build:mac`).
