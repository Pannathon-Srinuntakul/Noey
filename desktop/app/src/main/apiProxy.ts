import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { basename } from 'path'

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

async function runFetch(job: ApiFetchJob): Promise<ApiFetchResult> {
  const headers = { ...(job.headers ?? {}) }
  let body: BodyInit | undefined

  if (job.formFiles?.length || job.formFields) {
    const form = new FormData()
    for (const [key, value] of Object.entries(job.formFields ?? {})) {
      form.append(key, value)
    }
    for (const file of job.formFiles ?? []) {
      const data = await readFile(file.path)
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
  // Windows. 60s is generous for any of this app's endpoints (uploads
  // included) while still eventually freeing a permanently-stuck UI.
  const res = await fetch(job.url, {
    method: job.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(60_000)
  })
  return {
    ok: res.ok,
    status: res.status,
    bodyText: await res.text()
  }
}

export function registerApiProxyIpc(): void {
  ipcMain.handle('api:fetch', (_evt, job: ApiFetchJob) => runFetch(job))
}
