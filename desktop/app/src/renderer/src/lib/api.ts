/** Backend API client — same endpoints as the web app, but with the desktop
 * app's own JWT session (no session sharing with the browser). */

import { isTokenExpired } from './jwt'

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

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, init)
  } catch {
    throw new ApiError(0, `เชื่อมต่อ server ไม่ได้ (${baseUrl})`)
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
}

export function login(baseUrl: string, email: string, password: string): Promise<TokenPair> {
  return request<TokenPair>(baseUrl, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
