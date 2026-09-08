/**
 * Shared data shapes for the web platform layer.
 *
 * Copied verbatim from `desktop/app/src/preload/index.ts` (the type half only)
 * so the UI that was copied alongside it keeps compiling against exactly the
 * same contract. The runtime half — Electron IPC — is replaced by
 * `noey-web.ts`, which builds the same surface on OPFS, fetch and WebCodecs.
 *
 * Keep this in sync with the preload file when the desktop contract changes.
 * `NoeyApi` is deliberately NOT declared here: it is derived from the web
 * implementation (`typeof noey` in noey-web.ts), so anything the UI calls that
 * we have not implemented is a compile error rather than a runtime crash.
 */

export interface SidecarEvent {
  event: string
  [key: string]: unknown
}

export interface StoredAuth {
  baseUrl: string
  email: string
  accessToken: string
  refreshToken: string
}

export interface LocalClip {
  id: string
  file: string
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  originalPath?: string
}

export interface LocalProject {
  uid: string
  name: string
  mode?: 'dub_first' | 'talking_head' | 'highlight' | 'speech_highlights' | 'speech_scenes'
  step:
    /** Sources are being copied/transcoded in the background (see the
     * renderer's ProjectStep — this union mirrors it). */
    | 'importing'
    | 'imported'
    | 'analyzing'
    | 'silent_rendering'
    | 'waiting_vo'
    | 'planning'
    | 'final_rendering'
    | 'extracting_audio'
    | 'transcribing'
    | 'selecting'
    | 'rendering'
    | 'done'
    | 'error'
  createdAt: string
  updatedAt: string
  clips: LocalClip[]
  brief?: string
  userScript?: string
  scriptStyles?: string[]
  targetDurationSec?: number
  // Saved cut-style (EffectStyle kind="cut") uid chosen at creation; threads
  // into the analyze/reedit API calls as form field `style_uid`.
  /** Set while step==='importing': the source files the pipeline still has to
   * copy/transcode, and the music the user picked in the wizard. The wizard
   * hands these over instead of doing the work itself, so a slow HEVC import
   * runs in the background with its own progress + error like any other
   * stage. Cleared once the import lands. */
  pendingSources?: string[]
  pendingMusic?: { path: string; trimInSec: number; trimOutSec: number }
  cutStyleUid?: string
  /** AI quality tiers chosen at creation, re-sent on every analyze so a recut
   * repeats the user's choice. Absent on projects made before the feature —
   * the backend then falls back to its defaults. */
  engine?: 'lite' | 'pro'
  precision?: 'standard' | 'high'
  // Whether the AI should cut against the music's beat grid. Only meaningful
  // with `music` attached. Absent on projects created before the wizard
  // exposed the switch — those are treated as on, which is what they did.
  beatSync?: boolean
  /** Wall-clock seconds the last completed run took, measured by the pipeline.
   * Absent on projects finished before this was recorded, or resumed without a
   * timed run — the detail page then simply omits "ใช้เวลาทำ". */
  lastRunSeconds?: number
  remote?: { uid: string; jobId?: string }
  voiceoverPath?: string
  /** Recorded per-line takes, keyed by `voiceoverLineId`. The assembled
   * `voiceoverPath` is rebuilt from these, so re-recording one line never
   * requires re-recording the rest. */
  voiceoverTakes?: Record<string, { file: string; durationSec: number }>
  // dub_first background music — desktop-local file, mix params from the
  // TimelineEditor audio track, applied at render time by the sidecar.
  music?: {
    path: string
    volume: number
    offsetSec: number
    trimInSec: number
    trimOutSec: number | null
    muted: boolean
    // Beat timestamps (sec, full-track domain) from the server's librosa pass at
    // upload time — used client-side for magnetic snap-to-beat while trimming
    // dub scene cuts in TimelineEditor. Absent for tracks uploaded before this.
    beats?: number[]
  }
  /** speech_highlights (R17): display metadata for the N highlight clips (no embedded timelines). */
  highlightIndex?: Record<string, unknown>
  timeline?: Record<string, unknown>
  // dub_first only: the edit script the analyze step produced. Persisted so the
  // timeline editor stays available after an app restart — without this it only
  // lived in React state and a failed resume-fetch silently left it null forever,
  // permanently disabling the editor button with no visible error.
  editScript?: Record<string, unknown>
  // Real per-clip output durations from the silent render (same order as
  // editScript.segments) — see main/projects.ts for why buildEffectsCutPoints
  // needs these instead of the edit script's nominal duration math.
  clipDurationsSec?: number[]
  error?: string
  captionStyle?: { font: string; mode: string; color: string; border_color: string; size: number }
  /** dub_first/highlight caption lines in OUTPUT time. There are no word
   * timestamps for a dub (the voiceover is recorded against the cut, never
   * transcribed), so the lines themselves are the source of truth: derived
   * from the cut on first render, overwritten by the timeline editor, and
   * burned in by the sidecar on every later render. */
  captionLines?: { id: string; text: string; start: number; end: number }[]
  /** Every recut comment the user has sent, oldest first. Round 1 is the
   * original cut and has no entry — the first entry is round 2. */
  recutNotes?: { round: number; text: string; at: string }[]
  /** The render kept from before the latest recut, so a worse round can be
   * undone. One version only: recutting again overwrites it. Holds the edit
   * script + measured clip durations + timeline + caption lines alongside the
   * moved files, because restoring the video without them leaves the timeline
   * editor and the burned captions describing a cut no longer on disk. */
  previousRender?: {
    round: number
    at: string
    /** Project-relative paths, now living under `previous/`. */
    files: string[]
    editScript?: Record<string, unknown>
    clipDurationsSec?: number[]
    timeline?: Record<string, unknown>
    captionLines?: { id: string; text: string; start: number; end: number }[]
    /** R18b: this stash came from ปรับช็อต (shot swap), not a recut — the
     * revert path uses it to log the matching taste event. */
    fromShotSwap?: boolean
  }
}

/** R18b taste-log events (main/tasteLog.ts). `v`/`at` are stamped by main;
 * everything else comes from the renderer at COMMIT time only. */
export type TasteEvent =
  | {
      type: 'shot_swap'
      projectUid: string
      mode: string
      line: number
      from: { frame: number; desc: string }
      to: { frame: number; note: string }
    }
  | { type: 'shot_swap_revert'; projectUid: string; mode: string }
  | { type: 'recut_note'; projectUid: string; mode: string; round: number; text: string }

// Mirrors main/prefs.ts and main/storage.ts (preload defines its own view of
// every main-process shape, same as LocalProject above).
export interface Prefs {
  projectsDir: string | null
  defaultMode: 'silence' | 'highlight'
  defaultDuration: string
  defaultCaptions: boolean
  notifications: boolean
}

export interface StorageReport {
  root: string
  isDefault: boolean
  totalBytes: number
  projectCount: number
  /**
   * Web only: whether the browser has promised not to evict the store.
   * Optional so the desktop's report, which has no such notion, still fits.
   */
  persisted?: boolean
}

/**
 * The phone/LAN/remote contract used to be declared here in full — eight
 * interfaces describing a receive session, a remote switch, per-file upload
 * progress and so on. None of it has an implementation in a browser: the
 * runtime stub threw for every member and the UI that would call them is
 * hidden. Types with nothing behind them read as a feature that exists.
 *
 * `LanArtifact` survives as `Artifact` in platform/projects.ts, which is the
 * one shape the export screen actually reads.
 */

type ProgressUnsubscribe = () => void

export interface JobCommandApi {
  run: (job: unknown) => Promise<SidecarEvent>
  /**
   * Subscribe to this command's progress events.
   *
   * `projectDir` is not optional in spirit: progress is broadcast to the whole
   * renderer, so a listener without it also receives the events of every OTHER
   * project running the same command at the same time. Pass the same
   * `projectDir` the job was started with (main stamps each event with it).
   */
  onProgress: (cb: (evt: SidecarEvent) => void, projectDir?: string) => ProgressUnsubscribe
}
