/**
 * One place that turns a failed API response body into something a person can
 * read.
 *
 * FastAPI answers a validation failure with 422 and `detail` as an ARRAY of
 * `{loc, msg, type}` objects, not a string. Every client here tested
 * `typeof detail === 'string'`, so the array fell through and the user was
 * shown a bare "HTTP 422" — the one error whose body actually says exactly
 * what is wrong.
 */

type FieldError = { loc?: unknown[]; msg?: string; type?: string }

/** Last non-numeric path segment of `loc` — the field name, minus body/query. */
function fieldName(loc: unknown[] | undefined): string {
  if (!Array.isArray(loc)) return ''
  const parts = loc.filter(
    (p) => typeof p === 'string' && p !== 'body' && p !== 'query' && p !== 'path'
  )
  return parts.length ? String(parts[parts.length - 1]) : ''
}

/**
 * Human-readable message for a failed response.
 *
 * `body` is the parsed JSON body (or anything at all — a non-object is handled).
 * Falls back to `HTTP <status>` only when the body carries nothing usable.
 */
export function apiErrorDetail(status: number, body: unknown): string {
  // Status 0 is the web platform bridge's shape for "the request never got a
  // response" (platform/api.ts catch) -- the body is a raw exception message,
  // not a server detail. Without this branch every transport failure surfaced
  // as the string "HTTP 0".
  if (status === 0) return 'เชื่อมต่อ server ไม่ได้ ลองใหม่อีกครั้ง'

  const detail = (body as { detail?: unknown })?.detail

  if (typeof detail === 'string' && detail.trim()) return detail

  if (Array.isArray(detail)) {
    const parts = (detail as FieldError[])
      .map((e) => {
        const msg = typeof e?.msg === 'string' ? e.msg : ''
        if (!msg) return ''
        const field = fieldName(e?.loc)
        return field ? `${field}: ${msg}` : msg
      })
      .filter(Boolean)
    if (parts.length) return `ข้อมูลไม่ถูกต้อง — ${parts.join(', ')}`
  }

  // Some errors (worker/LiteLLM re-raises) put the text on `message` instead.
  const message = (body as { message?: unknown })?.message
  if (typeof message === 'string' && message.trim()) return message

  return `HTTP ${status}`
}

/**
 * `apiErrorDetail` for a failed response whose body may not be JSON.
 *
 * Callers used to write `detail = 'HTTP ' + status; detail = apiErrorDetail(status,
 * res.json())` inside a try. On web a transport failure arrives as status 0
 * with the raw exception text ("Failed to fetch") as its body, so `res.json()`
 * threw BEFORE `apiErrorDetail` could reach its status-0 branch — and the user
 * was shown a bare "HTTP 0" at the end of a render (live report 2026-09-21).
 * Parse first, never let a bad body skip the status mapping.
 */
export function responseErrorDetail(res: { status: number; json: () => unknown }): string {
  let body: unknown = null
  try {
    body = res.json()
  } catch {
    /* non-JSON body — the status alone decides */
  }
  return apiErrorDetail(res.status, body)
}
