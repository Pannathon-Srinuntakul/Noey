import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { appendLog } from './logger'

/** Renderer → main HTTP bridge. Bypasses browser CORS (Electron file:// / dev origin). */
export interface ApiFetchJob {
  url: string
  method?: string
  headers?: Record<string, string>
  jsonBody?: string
  formFields?: Record<string, string>
  formFiles?: { field: string; path: string; filename?: string }[]
}

export interface ApiFetchResult {
  ok: boolean
  status: number
  bodyText: string
}

let fetchSeq = 0

async function runFetch(job: ApiFetchJob): Promise<ApiFetchResult> {
  // Every request is logged start→end: a renderer stage that hangs on an
  // upload is indistinguishable from one that never issued the request, and
  // that ambiguity cost an evening (2026-08-13).
  const id = ++fetchSeq
  const started = Date.now()
  const label = `#${id} ${job.method ?? 'GET'} ${job.url}`
  void appendLog('api', `fetch start ${label} files=${job.formFiles?.length ?? 0}`)
  const headers = { ...(job.headers ?? {}) }
  let body: BodyInit | undefined
  let uploadBytes = 0

  if (job.formFiles?.length || job.formFields) {
    const form = new FormData()
    for (const [key, value] of Object.entries(job.formFields ?? {})) {
      form.append(key, value)
    }
    for (const file of job.formFiles ?? []) {
      const data = await readFile(file.path)
      uploadBytes += data.byteLength
      form.append(file.field, new Blob([data]), file.filename ?? basename(file.path))
    }
    body = form
  } else if (job.jsonBody !== undefined) {
    body = job.jsonBody
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json'
    }
  }

  // Without a timeout, a request in flight when the backend restarts (uvicorn
  // --reload) or drops the connection can hang forever — fetch() gives no
  // guarantee of ever rejecting on its own for a stalled/reset connection on
  // Windows.
  //
  // The budget cannot be a flat 60s: this bridge also carries the frame/WAV/
  // proxy uploads, and 60s at a real ADSL upstream is roughly 6 MB. A 40 MB cut
  // proxy on a slow line was aborted mid-transfer and surfaced as "TimeoutError"
  // — a working upload reported as a failure. So the ceiling scales with what is
  // actually being sent, at a deliberately pessimistic 100 KB/s floor.
  const timeoutMs = Math.min(30 * 60_000, 60_000 + (uploadBytes / 100_000) * 1000)
  try {
    const res = await fetch(job.url, {
      method: job.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
    const bodyText = await res.text()
    void appendLog('api', `fetch done ${label} status=${res.status} ms=${Date.now() - started}`)
    return { ok: res.ok, status: res.status, bodyText }
  } catch (err) {
    void appendLog(
      'api',
      `fetch FAILED ${label} ms=${Date.now() - started}: ${(err as Error)?.name}: ${(err as Error)?.message}`
    )
    throw err
  }
}

export function registerApiProxyIpc(): void {
  ipcMain.handle('api:fetch', (_evt, job: ApiFetchJob) => runFetch(job))
}
