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
  mode?: 'dub_first' | 'talking_head'
  step:
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
  remote?: { uid: string; jobId?: string }
  voiceoverPath?: string
  timeline?: Record<string, unknown>
  // dub_first only: the edit script the analyze step produced. Persisted so the
  // timeline editor stays available after an app restart — without this it only
  // lived in React state and a failed resume-fetch silently left it null forever,
  // permanently disabling the editor button with no visible error.
  editScript?: Record<string, unknown>
  error?: string
  captionStyle?: { font: string; mode: string; color: string; border_color: string; size: number }
}

type ProgressUnsubscribe = () => void

// Mirrors main/library.ts (preload defines its own view, same as LocalProject).
export interface EffectTemplate {
  id: string
  name: string
  createdAt: string
  instances: Record<string, unknown>[]
}

export interface StickerAsset {
  id: string
  name: string
  kind: 'lottie' | 'image'
  file: string
}

export interface JobCommandApi {
  run: (job: unknown) => Promise<SidecarEvent>
  onProgress: (cb: (evt: SidecarEvent) => void) => ProgressUnsubscribe
}

function jobCommand(channel: string): JobCommandApi {
  return {
    run: (job: unknown): Promise<SidecarEvent> => ipcRenderer.invoke(channel, job),
    onProgress: (cb: (evt: SidecarEvent) => void): ProgressUnsubscribe => {
      const listener = (_e: IpcRendererEvent, evt: SidecarEvent): void => cb(evt)
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
    extractFrames: jobCommand('sidecar:extractFrames'),
    extractProxy: jobCommand('sidecar:extractProxy'),
    renderSilent: jobCommand('sidecar:renderSilent'),
    renderFinal: jobCommand('sidecar:renderFinal'),
    extractAudio: jobCommand('sidecar:extractAudio'),
    renderTimeline: jobCommand('sidecar:renderTimeline'),
    renderAiPreview: jobCommand('sidecar:renderAiPreview'),
    compositeOverlay: jobCommand('sidecar:compositeOverlay'),
    renderEffects: jobCommand('sidecar:renderEffects'),
    proxyOne: jobCommand('sidecar:proxyOne'),
    cancel: (projectDir: string): Promise<void> => ipcRenderer.invoke('sidecar:cancel', projectDir)
  },
  // Node/Remotion sidecar — renders transparent effect overlays (see nodeSidecar.ts).
  nodeSidecar: {
    ping: (): Promise<SidecarEvent> => ipcRenderer.invoke('nodeSidecar:ping'),
    renderOverlay: jobCommand('nodeSidecar:renderOverlay'),
    renderGeneratedOverlay: jobCommand('nodeSidecar:renderGeneratedOverlay')
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
      ipcRenderer.invoke('projects:openFolder', uid, relPath)
  },
  media: {
    /** media:// URL for a file inside a project dir (path must be project-relative). */
    urlFor: (uid: string, relPath: string): string =>
      `media://project/${uid}/${relPath.split(/[\\/]/).map(encodeURIComponent).join('/')}`
  },
  // Local effects asset library (templates + stickers), reusable across projects.
  library: {
    listTemplates: (): Promise<EffectTemplate[]> => ipcRenderer.invoke('library:listTemplates'),
    saveTemplate: (name: string, instances: Record<string, unknown>[]): Promise<EffectTemplate> =>
      ipcRenderer.invoke('library:saveTemplate', name, instances),
    deleteTemplate: (id: string): Promise<void> => ipcRenderer.invoke('library:deleteTemplate', id),
    listStickers: (): Promise<StickerAsset[]> => ipcRenderer.invoke('library:listStickers'),
    stickerPath: (file: string): Promise<string> => ipcRenderer.invoke('library:stickerPath', file),
    deleteSticker: (id: string): Promise<void> => ipcRenderer.invoke('library:deleteSticker', id),
    importSticker: (): Promise<{ asset: StickerAsset; path: string } | null> =>
      ipcRenderer.invoke('library:importSticker')
  },
  auth: {
    save: (auth: StoredAuth): Promise<void> => ipcRenderer.invoke('auth:save', auth),
    load: (): Promise<StoredAuth | null> => ipcRenderer.invoke('auth:load'),
    clear: (): Promise<void> => ipcRenderer.invoke('auth:clear')
  },
  log: {
    write: (scope: string, message: string): Promise<void> =>
      ipcRenderer.invoke('log:write', scope, message),
    openFolder: (): Promise<void> => ipcRenderer.invoke('log:openFolder')
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
