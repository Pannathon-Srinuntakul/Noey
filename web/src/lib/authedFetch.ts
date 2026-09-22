/**
 * One authenticated `fetch` for the binary paths.
 *
 * WEB ONLY.
 *
 * `videosLocalApi.request` already refreshes on 401 and retries, but it speaks
 * JSON through the platform bridge and cannot stream a 300 MB body or read
 * binary back. So project sync, the codec converter and the storage panel each
 * called plain `fetch` with the session's token — and none of them refreshed.
 * An access token lives 30 minutes; every one of those calls simply started
 * failing after that, silently, with no path back short of a reload.
 *
 * This is the same contract in the shape those callers need: a `Response`, and
 * exactly one refresh-and-retry when the token has lapsed.
 */

import { refresh } from './api'
import type { ApiSession } from './videosLocalApi'
import { apiErrorDetail } from './apiError'
import { DEVICE_HEADER, deviceId } from './usageLimits'

export function apiBase(session: ApiSession): string {
  return session.baseUrl.replace(/\/+$/, '')
}

/**
 * Fetch `path` (relative to the session's base URL) with the bearer token.
 *
 * On 401 the token is refreshed once, the session object is updated in place —
 * every caller shares that object — and the request is retried. A refresh that
 * itself fails surfaces the original 401 rather than the refresh error: the
 * caller's message is about the thing it was doing.
 */
export async function authedFetch(
  session: ApiSession,
  path: string,
  init: RequestInit = {},
  retried = false
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${session.accessToken}`)
  // Same device id every other call sends (lib/httpClient.ts).
  if (!headers.has(DEVICE_HEADER)) headers.set(DEVICE_HEADER, deviceId())
  const res = await fetch(`${apiBase(session)}${path}`, { ...init, headers })

  if (res.status !== 401 || retried) return res

  try {
    const pair = await refresh(session.baseUrl, session.refreshToken)
    session.accessToken = pair.access_token
    session.refreshToken = pair.refresh_token
    session.onTokens?.(pair.access_token, pair.refresh_token)
  } catch {
    // Same contract as videosLocalApi.request: a dead refresh token ends the
    // session visibly instead of leaving a workspace where everything fails.
    const { emitAuthLost } = await import('./sessionBus')
    emitAuthLost()
    return res
  }
  return authedFetch(session, path, init, true)
}

/**
 * The server's own message for a failed response, or a fallback.
 *
 * The backend answers with `{"detail": "…"}` in Thai and already scrubs
 * anything technical, so showing it is both safe and far more useful than a
 * status code — "พื้นที่เก็บเต็มแล้ว (11.0 GB จาก 10.0 GB)" tells the user what
 * to do; "HTTP 507" does not.
 */
export async function serverMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.clone().json()) as { detail?: unknown }
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim()
    // An object detail (a billing refusal) is worded by the shared mapper.
    if (body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)) {
      const text = apiErrorDetail(res.status, body)
      if (!text.startsWith('HTTP ')) return text
    }
  } catch {
    // Not JSON — the fallback is the honest answer.
  }
  return `${fallback} (HTTP ${res.status})`
}
