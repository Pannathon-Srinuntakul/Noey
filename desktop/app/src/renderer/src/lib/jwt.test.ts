import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, isTokenExpired } from './jwt'

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesig`
}

describe('decodeJwtPayload', () => {
  it('decodes a valid token payload', () => {
    const token = makeToken({ sub: 7, tenant_slug: 'default', exp: 1234567890 })
    expect(decodeJwtPayload(token)).toEqual({ sub: 7, tenant_slug: 'default', exp: 1234567890 })
  })

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload('a.%%%.c')).toBeNull()
  })
})

describe('isTokenExpired', () => {
  const now = 1_700_000_000_000 // fixed clock (ms)

  it('false for a token expiring well in the future', () => {
    const token = makeToken({ exp: now / 1000 + 3600 })
    expect(isTokenExpired(token, 30, now)).toBe(false)
  })

  it('true for an expired token', () => {
    const token = makeToken({ exp: now / 1000 - 10 })
    expect(isTokenExpired(token, 30, now)).toBe(true)
  })

  it('true inside the skew window', () => {
    const token = makeToken({ exp: now / 1000 + 10 })
    expect(isTokenExpired(token, 30, now)).toBe(true)
  })

  it('true when exp is missing or token malformed', () => {
    expect(isTokenExpired(makeToken({ sub: 1 }), 30, now)).toBe(true)
    expect(isTokenExpired('garbage', 30, now)).toBe(true)
  })
})
