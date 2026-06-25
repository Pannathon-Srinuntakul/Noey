import type {
  ChatSessionDetail,
  ChatSessionOut,
  ColumnMeta,
  ColumnMetaIn,
  CreatorRow,
  CustomRowOut,
  CustomTableOut,
  RowsPage,
  DemographicsOut,
  FollowerHistoryRow,
  ImportRunOut,
  MarketRow,
  Overview,
  OverviewDailyRow,
  ProductRow,
  PromptOut,
  RunOut,
  SettingsIn,
  SettingsOut,
  SummaryOut,
  TiktokOverview,
  VideoRow,
  ViewersDailyRow,
} from './types'

// Local: Vite proxies /api → localhost:8000. Railway: set VITE_API_URL to the API service URL.
const BASE = import.meta.env.VITE_API_URL ?? '/api'

// Token getter — set by AuthContext; avoids circular import.
let _getToken: (() => string | null) | null = null
export function setTokenGetter(fn: () => string | null) { _getToken = fn }

let _onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) { _onUnauthorized = fn }

function handleUnauthorized(r: Response): void {
  if (r.status === 401) _onUnauthorized?.()
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const t = _getToken?.()
  if (t) headers.set('Authorization', `Bearer ${t}`)
  const r = await fetch(input, { ...init, headers })
  handleUnauthorized(r)
  return r
}

async function get<T>(path: string): Promise<T> {
  const r = await authFetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await authFetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return (r.status === 204 ? (undefined as T) : ((await r.json()) as T))
}

function qs(start?: string, end?: string): string {
  const p = new URLSearchParams()
  if (start) p.set('start', start)
  if (end) p.set('end', end)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Extract filename from Content-Disposition header, preferring UTF-8 filename*= over ASCII filename=. */
function _filenameFromDisp(disp: string | null, fallback: string): string {
  if (!disp) return fallback
  const utf8 = disp.match(/filename\*=UTF-8''([^;,\s]+)/i)
  if (utf8) {
    try { return decodeURIComponent(utf8[1]) } catch { /* fall through */ }
  }
  const ascii = disp.match(/filename="([^"]+)"/)
  return ascii ? ascii[1] : fallback
}

export const api = {
  overview: (start?: string, end?: string) => get<Overview>(`/metrics/overview${qs(start, end)}`),
  products: (start?: string, end?: string) => get<ProductRow[]>(`/products${qs(start, end)}`),
  creators: (start?: string, end?: string) => get<CreatorRow[]>(`/creators${qs(start, end)}`),
  market: () => get<MarketRow[]>(`/market/trends`),
  chatStream: async (
    message: string,
    sessionUid: string | null,
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<{ answer: string; sessionUid: string | null }> => {
    const r = await authFetch(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, session_uid: sessionUid }),
      signal,
    })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    if (!r.body) throw new Error('No response body')

    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let answer = ''
    let returnedSessionUid: string | null = sessionUid

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const evt = JSON.parse(line.slice(6)) as {
          type: string
          message?: string
          answer?: string
          session_uid?: string
        }
        if (evt.type === 'session' && evt.session_uid) returnedSessionUid = evt.session_uid
        if (evt.type === 'status' && evt.message) onStatus(evt.message)
        if (evt.type === 'done' && evt.answer !== undefined) answer = evt.answer
        if (evt.type === 'error') throw new Error(evt.message ?? 'Chat failed')
      }
    }
    return { answer, sessionUid: returnedSessionUid }
  },

  chatSessions: {
    list: () => get<ChatSessionOut[]>('/chat/sessions'),
    create: () => send<ChatSessionOut>('/chat/sessions', 'POST'),
    get: (uid: string) => get<ChatSessionDetail>(`/chat/sessions/${uid}`),
    delete: (uid: string) => send<void>(`/chat/sessions/${uid}`, 'DELETE'),
    rename: (uid: string, title: string) =>
      send<ChatSessionOut>(`/chat/sessions/${uid}`, 'PATCH', { title }),
  },
  listPrompts: () => get<PromptOut[]>(`/prompts`),
  createPrompt: (b: { name: string; prompt: string; schedule: string; enabled?: boolean }) =>
    send<PromptOut>(`/prompts`, 'POST', b),
  updatePrompt: (
    id: number,
    b: { name: string; prompt: string; schedule: string; enabled: boolean },
  ) => send<PromptOut>(`/prompts/${id}`, 'PUT', b),
  deletePrompt: (id: number) => send<void>(`/prompts/${id}`, 'DELETE'),
  listRuns: () => get<RunOut[]>(`/runs`),
  getSettings: () => get<SettingsOut>(`/settings`),
  putSettings: (b: SettingsIn) => send<SettingsOut>(`/settings`, 'PUT', b),

  // CSV Import
  importCsv: (files: FileList | File[], exportDate?: string): Promise<ImportRunOut> => {
    const form = new FormData()
    Array.from(files).forEach((f) => form.append('files', f))
    const url = exportDate ? `${BASE}/import?export_date=${exportDate}` : `${BASE}/import`
    return fetch(url, { method: 'POST', body: form }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return r.json() as Promise<ImportRunOut>
    })
  },
  listImportRuns: () => get<ImportRunOut[]>('/import/runs'),

  // Analytics
  analyticsOverview: (start?: string, end?: string) =>
    get<TiktokOverview>(`/analytics/overview${qs(start, end)}`),
  analyticsOverviewTimeseries: (start?: string, end?: string) =>
    get<OverviewDailyRow[]>(`/analytics/overview/timeseries${qs(start, end)}`),
  analyticsFollowers: (start?: string, end?: string) =>
    get<FollowerHistoryRow[]>(`/analytics/followers${qs(start, end)}`),
  analyticsViewers: (start?: string, end?: string) =>
    get<ViewersDailyRow[]>(`/analytics/viewers${qs(start, end)}`),
  analyticsContent: (start?: string, end?: string, limit = 100) => {
    const base = qs(start, end)
    const sep = base ? '&' : '?'
    return get<VideoRow[]>(`/analytics/content${base}${sep}limit=${limit}`)
  },
  analyticsDemographics: () => get<DemographicsOut>('/analytics/demographics'),

  // Custom Tables
  tables: {
    list: () => get<CustomTableOut[]>('/tables'),
    create: (display_name: string) =>
      send<CustomTableOut>('/tables', 'POST', { display_name }),
    get: (uid: string) => get<CustomTableOut>(`/tables/${uid}`),
    rename: (uid: string, display_name: string) =>
      send<CustomTableOut>(`/tables/${uid}`, 'PATCH', { display_name }),
    delete: (uid: string) => send<void>(`/tables/${uid}`, 'DELETE'),
    addColumn: (uid: string, body: ColumnMetaIn) =>
      send<ColumnMeta>(`/tables/${uid}/columns`, 'POST', body),
    updateColumn: (
      uid: string,
      key: string,
      body: { label?: string; options?: string[]; width?: number },
    ) => send<ColumnMeta>(`/tables/${uid}/columns/${key}`, 'PATCH', body),
    deleteColumn: (uid: string, key: string) =>
      send<void>(`/tables/${uid}/columns/${key}`, 'DELETE'),
    reorderColumns: (uid: string, keys: string[]) =>
      send<CustomTableOut>(`/tables/${uid}/columns/reorder`, 'POST', { keys }),
    rows: (
      uid: string,
      params?: { page?: number; page_size?: number; sort_by?: string; sort_dir?: string; q?: string; filters?: string },
    ) => {
      const p = new URLSearchParams()
      if (params?.page) p.set('page', String(params.page))
      if (params?.page_size) p.set('page_size', String(params.page_size))
      if (params?.sort_by) p.set('sort_by', params.sort_by)
      if (params?.sort_dir) p.set('sort_dir', params.sort_dir)
      if (params?.q) p.set('q', params.q)
      if (params?.filters) p.set('filters', params.filters)
      const qs = p.toString()
      return get<RowsPage>(`/tables/${uid}/rows${qs ? '?' + qs : ''}`)
    },
    addRow: (uid: string, data: Record<string, unknown>) =>
      send<CustomRowOut>(`/tables/${uid}/rows`, 'POST', { data }),
    updateRow: (uid: string, rid: string, data: Record<string, unknown>) =>
      send<CustomRowOut>(`/tables/${uid}/rows/${rid}`, 'PUT', { data }),
    deleteRow: (uid: string, rid: string) =>
      send<void>(`/tables/${uid}/rows/${rid}`, 'DELETE'),
    bulkDelete: (uid: string, ids: string[]) =>
      send<void>(`/tables/${uid}/rows/bulk-delete`, 'POST', { ids }),
    reorder: (ids: string[]) =>
      send<CustomTableOut[]>('/tables', 'PATCH', { ids }),
    summary: (uid: string, groupBy: string) =>
      get<SummaryOut>(`/tables/${uid}/summary?group_by=${groupBy}`),
    setSummaryConfig: (uid: string, config: { col_key: string; aggs: string[] }[]) =>
      send<CustomTableOut>(`/tables/${uid}/summary-config`, 'PUT', { config }),
    exportCsv: async (uid: string, ids?: string[]) => {
      const qs = ids?.length ? `?ids=${ids.join(',')}` : ''
      const r = await authFetch(`/api/tables/${uid}/export.csv${qs}`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = _filenameFromDisp(r.headers.get('content-disposition'), 'export.csv')
      a.click()
      URL.revokeObjectURL(url)
    },
    sampleCsv: async (uid: string) => {
      const r = await authFetch(`/api/tables/${uid}/sample.csv`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = _filenameFromDisp(r.headers.get('content-disposition'), 'sample.csv')
      a.click()
      URL.revokeObjectURL(url)
    },
    importCsv: (uid: string, file: File): Promise<{ rows_inserted: number; rows_updated: number; rows_skipped: number; errors: string[] }> => {
      const form = new FormData()
      form.append('file', file)
      return authFetch(`/api/tables/${uid}/import`, { method: 'POST', body: form }).then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().then((d: Record<string, unknown>) => d.detail as string).catch(() => r.statusText)
          throw new Error(detail)
        }
        return r.json()
      })
    },
  },

  // Background jobs
  getJob: (jobId: string) => get<{ id: string; type: string; status: string; progress: number; result: Record<string, unknown> | null; error: string | null }>(`/jobs/${jobId}`),

  // AI Video Editing
  videos: {
    upload: (
      files: File[],
      options?: {
        mode?: string
        brief?: string
        userScript?: string
        durationMode?: 'full' | 'auto' | 'custom'
        targetDurationSec?: number | null
        uploadMode?: 'merge' | 'separate'
      },
    ): Promise<{ projects: { project_uid: string; job_id: string }[] }> => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f))
      form.append('mode', options?.mode ?? 'talking_head')
      form.append('upload_mode', options?.uploadMode ?? 'merge')
      form.append('duration_mode', options?.durationMode ?? 'full')
      if (options?.targetDurationSec != null) {
        form.append('target_duration_sec', String(options.targetDurationSec))
      }
      if (options?.brief) form.append('brief', options.brief)
      if (options?.userScript) form.append('user_script', options.userScript)
      return authFetch(`${BASE}/videos`, { method: 'POST', body: form }).then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().then((d: Record<string, unknown>) => d.detail as string).catch(() => r.statusText)
          throw new Error(detail)
        }
        return r.json()
      })
    },
    uploadVoiceover: (uid: string, file: File): Promise<VideoProjectOut> => {
      const form = new FormData()
      form.append('file', file)
      return authFetch(`${BASE}/videos/${uid}/voiceover`, { method: 'POST', body: form }).then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().then((d: Record<string, unknown>) => d.detail as string).catch(() => r.statusText)
          throw new Error(detail)
        }
        return r.json()
      })
    },
    list: () => get<VideoProjectOut[]>('/videos'),
    get: (uid: string) => get<VideoProjectOut>(`/videos/${uid}`),
    downloadFinal: async (uid: string, filename = 'final.mp4') => {
      const r = await authFetch(`${BASE}/videos/${uid}/download`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    },
    fetchFinalVideoBlob: async (uid: string): Promise<Blob> => {
      const r = await authFetch(`${BASE}/videos/${uid}/download`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return r.blob()
    },
    exportCapcut: async (uid: string) => {
      const r = await authFetch(`${BASE}/videos/${uid}/export/capcut`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `capcut_bundle_${uid.slice(0, 8)}.zip`; a.click()
      URL.revokeObjectURL(url)
    },
    cancel: (uid: string) => send<VideoProjectOut>(`/videos/${uid}/cancel`, 'POST'),
    delete: (uid: string) => send<void>(`/videos/${uid}`, 'DELETE'),
    getEditScript: (uid: string) => get<DubEditScript>(`/videos/${uid}/edit-script`),
  },

}

export interface VideoProjectOut {
  uid: string
  mode: string
  status: 'pending' | 'processing' | 'waiting_vo' | 'done' | 'error' | 'cancelled'
  job_id: string | null
  duration_mode: 'full' | 'auto' | 'custom'
  target_duration_sec: number | null
  clip_count: number
  brief: string | null
  user_script: string | null
  final_path: string | null
  zip_path: string | null
  error_msg: string | null
  edit_script_path: string | null
  voiceover_path: string | null
  created_at: string
}

export interface DubEditScript {
  mode?: string
  totalEstimatedSec?: number
  segments: {
    order: number
    sourceClip: string
    sourceIn: number
    sourceOut: number
    outputIn?: number
    outputOut?: number
    voiceoverLineId?: number
    voiceoverLineOutputIn?: number
    voiceoverLineOutputOut?: number
    durationSec: number
    voiceoverScript: string
    visualDescription?: string
    cutStyle?: string
  }[]
}
