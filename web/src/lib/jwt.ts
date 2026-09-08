/** Minimal JWT payload inspection — no signature verification (server does that). */

export interface JwtPayload {
  exp?: number
  sub?: string | number
  tenant_slug?: string
  type?: string
  [key: string]: unknown
}

/** Decode the payload segment of a JWT. Returns null on any malformed input. */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(atob(padded)) as JwtPayload
  } catch {
    return null
  }
}

/**
 * True when the token is expired (or expires within `skewSec` seconds, to
 * avoid sending a token that dies mid-request). Malformed tokens count as
 * expired.
 */
export function isTokenExpired(token: string, skewSec = 30, nowMs = Date.now()): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload?.exp) return true
  return payload.exp * 1000 <= nowMs + skewSec * 1000
}
