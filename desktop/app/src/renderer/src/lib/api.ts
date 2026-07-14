/** Backend API client — same endpoints as the web app, but with the desktop
 * app's own JWT session (no session sharing with the browser). */

import { isTokenExpired } from './jwt'
import { apiFetch } from './httpClient'

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface Me {
  user_id: number
  email: string
  tenant_id: number
  tenant_slug: string
  role: string
  is_admin: boolean
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string
  ) {
    super(detail)
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function request<T>(baseUrl: string, path: string, init?: ApiFetchInit): Promise<T> {
  let res
  try {
    res = await apiFetch(apiUrl(baseUrl, path), init)
  } catch (err) {
    void window.noey.log.write('api', `fetch failed ${baseUrl}${path}: ${String(err)}`)
    throw new ApiError(0, 'เชื่อมต่อ server ไม่ได้ ลองใหม่อีกครั้ง')
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = res.json() as { detail?: string }
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json() as T
}

type ApiFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  formFields?: Record<string, string>
  formFiles?: { field: string; path: string; filename?: string }[]
}

export function login(baseUrl: string, email: string, password: string): Promise<TokenPair> {
  return request<TokenPair>(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })
}

export function refresh(baseUrl: string, refreshToken: string): Promise<TokenPair> {
  // Backend expects the refresh token as a Bearer credential, not a JSON body.
  return request<TokenPair>(baseUrl, '/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshToken}` }
  })
}

export function me(baseUrl: string, accessToken: string): Promise<Me> {
  return request<Me>(baseUrl, '/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

export interface UsageByFeature {
  feature: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface Usage {
  user_id: number
  plan: string
  period_start: string
  used_tokens: number
  input_tokens: number
  output_tokens: number
  limit_tokens: number
  unlimited: boolean
  remaining_tokens: number | null
  usage_pct: number | null
  by_feature: UsageByFeature[]
  reset_at: string | null
  // estimated_cost_usd exists on the backend response but is deliberately
  // left off this type — cost is never shown in this app.
}

export function getUsage(baseUrl: string, accessToken: string): Promise<Usage> {
  return request<Usage>(baseUrl, '/usage/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

/**
 * Restore a stored session: reuse the access token if still valid, otherwise
 * try the refresh token. Returns the (possibly renewed) pair, or null when
 * the session can't be restored and the user must log in again.
 */
export async function restoreSession(
  baseUrl: string,
  accessToken: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string } | null> {
  if (!isTokenExpired(accessToken)) {
    return { access_token: accessToken, refresh_token: refreshToken }
  }
  if (isTokenExpired(refreshToken)) return null
  try {
    const pair = await refresh(baseUrl, refreshToken)
    return { access_token: pair.access_token, refresh_token: pair.refresh_token }
  } catch {
    return null
  }
}
