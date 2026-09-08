/**
 * `api.fetch` — the one call every backend request in the UI goes through.
 *
 * On desktop this hops to the Electron main process, which reads upload files
 * off disk by absolute path and sidesteps CORS. Here it is a plain `fetch`, so
 * two things change and the rest of `lib/httpClient.ts` and the four API
 * modules keep working untouched:
 *
 *   - `formFiles[].path` now names a file in the project store (or a fresh
 *     pick), and the bytes are read from OPFS instead of the filesystem;
 *   - the backend must allow this origin (`CORS_EXTRA_ORIGINS`), because there
 *     is no main process to hide behind.
 *
 * The upload timeout formula is copied from `main/apiProxy.ts:38`. Its
 * `Math.ceil` is load-bearing: `AbortSignal.timeout()` throws a RangeError on a
 * fractional delay, before the request is even issued — that shipped as a bug
 * once already.
 */

import { getPicked } from './picked'
import { isPickedPath, readFile } from './fs'

export interface ApiFetchJob {
  url: string
  method?: string
  headers?: Record<string, string>
  jsonBody?: unknown
  formFields?: Record<string, string>
  formFiles?: { field: string; path: string; filename?: string }[]
}

export interface ApiFetchResult {
  ok: boolean
  status: number
  bodyText: string
}

/** 60 s, plus a second per 100 KB, capped at 30 minutes. */
function uploadTimeoutMs(bytes: number): number {
  return Math.ceil(Math.min(30 * 60_000, 60_000 + (bytes / 100_000) * 1000))
}

async function blobFor(path: string): Promise<{ blob: Blob; name: string }> {
  if (isPickedPath(path)) {
    const file = getPicked(path)
    if (!file) throw new Error('ไฟล์ที่เลือกไว้หายไปแล้ว')
    return { blob: file, name: file.name }
  }
  const file = await readFile(path)
  if (!file) throw new Error(`ไม่พบไฟล์ ${path}`)
  return { blob: file, name: path.split('/').pop() ?? 'file' }
}

export async function apiFetch(job: ApiFetchJob): Promise<ApiFetchResult> {
  const { url, method = 'GET', headers = {}, jsonBody, formFields, formFiles } = job

  let body: BodyInit | undefined
  let bytes = 0
  const outHeaders: Record<string, string> = { ...headers }

  if (formFiles?.length || formFields) {
    const form = new FormData()
    for (const [k, v] of Object.entries(formFields ?? {})) form.append(k, v)
    for (const f of formFiles ?? []) {
      const { blob, name } = await blobFor(f.path)
      bytes += blob.size
      form.append(f.field, blob, f.filename ?? name)
    }
    body = form
    // Never set Content-Type for FormData: the browser has to add the boundary.
    delete outHeaders['Content-Type']
    delete outHeaders['content-type']
  } else if (jsonBody !== undefined) {
    // `httpClient.ts` hands this over ALREADY SERIALISED (`jsonBody: init.body`,
    // where body is a JSON string), and the desktop proxy passes it straight to
    // fetch. Stringifying again wraps it in quotes and the server rejects the
    // result as a string where it wanted an object — a 422 on every login.
    body = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody)
    bytes = body.length
    if (!outHeaders['Content-Type'] && !outHeaders['content-type']) {
      outHeaders['Content-Type'] = 'application/json'
    }
  }

  try {
    const res = await fetch(url, {
      method,
      headers: outHeaders,
      body,
      signal: AbortSignal.timeout(uploadTimeoutMs(bytes))
    })
    return { ok: res.ok, status: res.status, bodyText: await res.text() }
  } catch (err) {
    // Same shape the desktop proxy returns on a transport failure, so
    // `readApiError` upstream keeps producing a readable message.
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, bodyText: message }
  }
}
