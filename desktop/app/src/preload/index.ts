import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface SidecarEvent {
  event: string
  [key: string]: unknown
}

export interface RenderJobSpec {
  source: string
  output: string
  cuts: { start: number; end: number }[]
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
  mode?: 'dub_first' | 'talking_head' | 'highlight'
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
  }
}

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
}

export type MoveResult =
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: string }
  | { status: 'moved'; root: string; projects: number }

type ProgressUnsubscribe = () => void

// LAN receive (mirrors src/main/lanReceive.ts)
interface LanReceiveSession {
  sessionId: string
  port: number
  token: string
  ips: { name: string; address: string; ssid?: string }[]
  /** How long the server waits with no traffic before shutting itself down —
   * the modal counts this down so the timeout is never a surprise. */
  idleMs: number
}

interface LanReceivedFile {
  fileId: string
  path: string
  name: string
  size: number
}

interface LanUploadProgress {
  fileId: string
  name: string
  receivedBytes: number
  totalBytes: number
}

interface LanStopped {
  /** 'abuse' — shut down after too many rejected tokens (see MAX_BAD_TOKENS). */
  reason: 'idle' | 'manual' | 'abuse'
}

interface LanArtifact {
  id: string
  path: string
  label: string
  name: string
  size: number
  kind: 'final' | 'subs' | 'scene' | 'bundle'
}

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

function jobCommand(channel: string): JobCommandApi {
  return {
    run: (job: unknown): Promise<SidecarEvent> => ipcRenderer.invoke(channel, job),
    onProgress: (cb: (evt: SidecarEvent) => void, projectDir?: string): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, evt: SidecarEvent): void => {
        if (projectDir && evt.projectDir !== projectDir) return
        cb(evt)
      }
      ipcRenderer.on(`${channel}-progress`, listener)
      return () => ipcRenderer.removeListener(`${channel}-progress`, listener)
    }
  }
}

// Typed bridge for the renderer — sidecar render engine, local projects,
// media:// URLs, and the encrypted auth store.
const noey = {
  platform: process.platform,
  sidecar: {
    ping: (): Promise<SidecarEvent> => ipcRenderer.invoke('sidecar:ping'),
    probe: (file: string): Promise<SidecarEvent> => ipcRenderer.invoke('sidecar:probe', file),
    render: jobCommand('sidecar:render'),
    ingest: jobCommand('sidecar:ingest'),
    extractProxy: jobCommand('sidecar:extractProxy'),
    renderSilent: jobCommand('sidecar:renderSilent'),
    renderFinal: jobCommand('sidecar:renderFinal'),
    mixMusic: jobCommand('sidecar:mixMusic'),
    extractAudio: jobCommand('sidecar:extractAudio'),
    renderTimeline: jobCommand('sidecar:renderTimeline'),
    renderAiPreview: jobCommand('sidecar:renderAiPreview'),
    renderEffects: jobCommand('sidecar:renderEffects'),
    proxyOne: jobCommand('sidecar:proxyOne'),
    cancel: (projectDir: string): Promise<void> => ipcRenderer.invoke('sidecar:cancel', projectDir)
  },
  projects: {
    list: (): Promise<LocalProject[]> => ipcRenderer.invoke('projects:list'),
    get: (uid: string): Promise<LocalProject | null> => ipcRenderer.invoke('projects:get', uid),
    create: (init: Partial<LocalProject> & { name: string }): Promise<LocalProject> =>
      ipcRenderer.invoke('projects:create', init),
    update: (uid: string, patch: Partial<LocalProject>): Promise<LocalProject> =>
      ipcRenderer.invoke('projects:update', uid, patch),
    delete: (uid: string): Promise<void> => ipcRenderer.invoke('projects:delete', uid),
    dir: (uid: string): Promise<string> => ipcRenderer.invoke('projects:dir', uid),
    resolvePath: (uid: string, relPath: string): Promise<string> =>
      ipcRenderer.invoke('projects:resolvePath', uid, relPath),
    openFolder: (uid: string, relPath?: string): Promise<void> =>
      ipcRenderer.invoke('projects:openFolder', uid, relPath),
    /** Copy a rendered artifact out to a user-chosen path via a native save
     * dialog. Resolves to the destination, or null if the user cancels. */
    exportFile: (uid: string, relPath: string, suggestedName: string): Promise<string | null> =>
      ipcRenderer.invoke('projects:exportFile', uid, relPath, suggestedName),
    /** Copy chosen artifacts (same ids as `lan.artifacts`) out to disk: a Save
     * dialog for one file, a folder picker for several. Resolves to null when
     * the user cancels. */
    exportArtifacts: (
      uid: string,
      fileIds: string[],
      projectName: string
    ): Promise<{ dir: string; files: number } | null> =>
      ipcRenderer.invoke('projects:exportArtifacts', uid, fileIds, projectName),
    /** Copy a user-picked music/video file into the project dir; returns the
     * project-relative path (servable via media://, resolvable for the sidecar). */
    importMusic: (uid: string, srcPath: string): Promise<string> =>
      ipcRenderer.invoke('projects:importMusic', uid, srcPath),
    /** Write renderer-produced bytes (a recorded voiceover take) into the
     * project dir. Returns the absolute path, for handing to the sidecar. */
    writeFile: (uid: string, relPath: string, data: Uint8Array): Promise<string> =>
      ipcRenderer.invoke('projects:writeFile', uid, relPath, data),
    deleteFile: (uid: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke('projects:deleteFile', uid, relPath),
    /** Move this round's render products under `previous/`, replacing anything
     * kept before; returns the project-relative paths that moved. */
    stashRender: (uid: string): Promise<string[]> =>
      ipcRenderer.invoke('projects:stashRender', uid),
    /** Put `previous/` back and discard the current render. */
    restoreRender: (uid: string): Promise<void> => ipcRenderer.invoke('projects:restoreRender', uid)
  },
  media: {
    /** media:// URL for a file inside a project dir (path must be project-relative). */
    urlFor: (uid: string, relPath: string): string =>
      `media://project/${uid}/${relPath.split(/[\\/]/).map(encodeURIComponent).join('/')}`,
    /** media:// URL for a clip sitting in the LAN inbox — the only way the
     * wizard can decode a frame from a phone upload, which arrives as a path
     * with no `File` object behind it. Takes the absolute path the transfer
     * reported and uses its file name. */
    inboxUrlFor: (absPath: string): string =>
      `media://inbox/${encodeURIComponent(absPath.split(/[\\/]/).pop() ?? '')}`
  },
  // User preferences (userData/prefs.json) — see main/prefs.ts.
  prefs: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('prefs:get'),
    /** Partial merge; resolves to the full prefs object after the write. */
    set: (patch: Partial<Prefs>): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch)
  },
  // Library disk accounting + move — see main/storage.ts.
  storage: {
    report: (): Promise<StorageReport> => ipcRenderer.invoke('storage:report'),
    moveLibrary: (): Promise<MoveResult> => ipcRenderer.invoke('storage:moveLibrary')
  },
  auth: {
    save: (auth: StoredAuth): Promise<void> => ipcRenderer.invoke('auth:save', auth),
    load: (): Promise<StoredAuth | null> => ipcRenderer.invoke('auth:load'),
    clear: (): Promise<void> => ipcRenderer.invoke('auth:clear')
  },
  // Unrendered-work guard: a screen publishes a reason while it holds edits
  // that have not been rendered, and answers the close prompt with its own
  // in-app dialog (see main/unsavedGuard.ts).
  app: {
    setUnsaved: (reason: string | null): Promise<void> =>
      ipcRenderer.invoke('app:setUnsaved', reason),
    allowClose: (): Promise<void> => ipcRenderer.invoke('app:allowClose'),
    cancelClose: (): Promise<void> => ipcRenderer.invoke('app:cancelClose'),
    onCloseRequested: (cb: (reason: string) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, reason: string): void => cb(reason)
      ipcRenderer.on('app:close-requested', listener)
      return () => ipcRenderer.removeListener('app:close-requested', listener)
    }
  },
  log: {
    write: (scope: string, message: string): Promise<void> =>
      ipcRenderer.invoke('log:write', scope, message),
    openFolder: (): Promise<void> => ipcRenderer.invoke('log:openFolder')
  },
  // OS notification for jobs that finish while the window is unfocused.
  // Resolves false when suppressed (window focused) or unsupported.
  notify: {
    show: (payload: { title: string; body: string; projectUid?: string }): Promise<boolean> =>
      ipcRenderer.invoke('notify:show', payload),
    /** Fires with the project uid when the user clicks a notification. */
    onActivated: (cb: (projectUid: string) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, uid: string): void => cb(uid)
      ipcRenderer.on('notify:activated', listener)
      return () => ipcRenderer.removeListener('notify:activated', listener)
    }
  },
  api: {
    fetch: (job: {
      url: string
      method?: string
      headers?: Record<string, string>
      jsonBody?: string
      formFields?: Record<string, string>
      formFiles?: { field: string; path: string; filename?: string }[]
    }): Promise<{ ok: boolean; status: number; bodyText: string }> =>
      ipcRenderer.invoke('api:fetch', job)
  },
  lan: {
    start: (): Promise<LanReceiveSession> => ipcRenderer.invoke('lan:start'),
    /** Pass the sessionId from start()/startSend() so a closing modal never
     * kills a newer session another surface started. */
    stop: (onlySessionId?: string): Promise<void> => ipcRenderer.invoke('lan:stop', onlySessionId),
    onFile: (cb: (f: LanReceivedFile) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, f: LanReceivedFile): void => cb(f)
      ipcRenderer.on('lan:file', listener)
      return () => ipcRenderer.removeListener('lan:file', listener)
    },
    onProgress: (cb: (p: LanUploadProgress) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, p: LanUploadProgress): void => cb(p)
      ipcRenderer.on('lan:progress', listener)
      return () => ipcRenderer.removeListener('lan:progress', listener)
    },
    /** A transfer that will never finish — cancelled by either end, or broken. */
    onFailed: (
      cb: (f: { fileId: string; name: string; reason: 'cancelled' | 'error' }) => void
    ): ProgressUnsubscribe => {
      const listener = (
        _e: IpcRendererEvent,
        f: { fileId: string; name: string; reason: 'cancelled' | 'error' }
      ): void => cb(f)
      ipcRenderer.on('lan:failed', listener)
      return () => ipcRenderer.removeListener('lan:failed', listener)
    },
    /** The upload page on the phone is still open — heartbeats once a minute,
     * so the countdown here can follow the server's own idle timer instead of
     * expiring while someone is still choosing a clip out of Photos. */
    onAlive: (cb: () => void): ProgressUnsubscribe => {
      const listener = (): void => cb()
      ipcRenderer.on('lan:alive', listener)
      return () => ipcRenderer.removeListener('lan:alive', listener)
    },
    /** An already-received file was thrown away (from the phone or from here). */
    onRemoved: (cb: (f: { fileId: string }) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, f: { fileId: string }): void => cb(f)
      ipcRenderer.on('lan:removed', listener)
      return () => ipcRenderer.removeListener('lan:removed', listener)
    },
    /** Stop an in-flight transfer / delete one that already landed. `path` is
     * the fallback for a row whose LAN session has since been replaced (idle
     * stop, or "เปิดรับอีกครั้ง") — main only honours it inside the inbox. */
    cancelFile: (fileId: string, path?: string): Promise<void> =>
      ipcRenderer.invoke('lan:cancelFile', fileId, path),
    onStopped: (cb: (s: LanStopped) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, s: LanStopped): void => cb(s)
      ipcRenderer.on('lan:stopped', listener)
      return () => ipcRenderer.removeListener('lan:stopped', listener)
    },
    artifacts: (projectUid: string): Promise<LanArtifact[]> =>
      ipcRenderer.invoke('lan:artifacts', projectUid),
    startSend: (projectUid: string, fileIds: string[]): Promise<LanReceiveSession> =>
      ipcRenderer.invoke('lan:startSend', projectUid, fileIds),
    onSent: (cb: (s: { fileId: string }) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, s: { fileId: string }): void => cb(s)
      ipcRenderer.on('lan:sent', listener)
      return () => ipcRenderer.removeListener('lan:sent', listener)
    }
  }
}

export type NoeyApi = typeof noey

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('noey', noey)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.noey = noey
}
