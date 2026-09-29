import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import {
  GOOGLE_FLOW_KEY,
  beginGoogle,
  googleErrorText,
  googleRedirectUri,
  isGoogleCallbackPath,
  parseGoogleReturn,
  peekGoogleOutcome,
  stashGoogleOutcome,
  takeGoogleOutcome
} from './googleAuth'

function memoryStore(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

describe('redirect uri', () => {
  it('is the origin plus the callback path, with no trailing slash doubling', () => {
    expect(googleRedirectUri('https://studio.example.com')).toBe(
      'https://studio.example.com/auth/google/callback'
    )
    expect(googleRedirectUri('http://localhost:5174/')).toBe(
      'http://localhost:5174/auth/google/callback'
    )
    expect(isGoogleCallbackPath('/auth/google/callback')).toBe(true)
    expect(isGoogleCallbackPath('/auth/google/callback/')).toBe(false)
  })
})

describe('beginGoogle', () => {
  it('keeps state in this tab, then navigates the top window to Google', async () => {
    const start = vi.fn(async () => ({
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      state: 'st-1',
      expires_in: 600
    }))
    const storage = memoryStore()
    const navigate = vi.fn()
    await beginGoogle({
      baseUrl: 'https://api',
      origin: 'https://studio',
      intent: 'link',
      returnTo: 'settings',
      accessToken: 'acc',
      storage,
      navigate,
      start
    })
    expect(start).toHaveBeenCalledWith(
      'https://api',
      { redirect_uri: 'https://studio/auth/google/callback', intent: 'link' },
      'acc'
    )
    expect(JSON.parse(storage.getItem(GOOGLE_FLOW_KEY)!)).toEqual({
      state: 'st-1',
      intent: 'link',
      returnTo: 'settings'
    })
    expect(navigate).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it('sends the Turnstile token on a sign-in only, never on link / reauth', async () => {
    const start = vi.fn(async () => ({
      authorization_url: 'https://g',
      state: 's',
      expires_in: 600
    }))
    const common = {
      baseUrl: 'b',
      origin: 'https://o',
      storage: memoryStore(),
      navigate: vi.fn(),
      start
    }
    await beginGoogle({ ...common, intent: 'signin', returnTo: 'login', turnstileToken: 'tok' })
    await beginGoogle({ ...common, intent: 'signin', returnTo: 'login' })
    await beginGoogle({
      ...common,
      intent: 'link',
      returnTo: 'settings',
      turnstileToken: 'tok',
      accessToken: 'a'
    })
    expect(start.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { redirect_uri: 'https://o/auth/google/callback', intent: 'signin', turnstile_token: 'tok' },
      { redirect_uri: 'https://o/auth/google/callback', intent: 'signin' },
      { redirect_uri: 'https://o/auth/google/callback', intent: 'link' }
    ])
  })

  it('stores nothing and does not navigate when the server refuses', async () => {
    const start = async (): Promise<never> => {
      throw new ApiError(503, 'x', null, 'not_configured')
    }
    const storage = memoryStore()
    const navigate = vi.fn()
    const caught = await beginGoogle({
      baseUrl: 'b',
      origin: 'o',
      intent: 'signin',
      returnTo: 'login',
      storage,
      navigate,
      start
    }).then(
      () => null,
      (e: unknown) => e
    )
    expect(caught).toBeInstanceOf(ApiError)
    expect(storage.getItem(GOOGLE_FLOW_KEY)).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('parseGoogleReturn', () => {
  const keep = (storage: Storage, state = 'good', intent = 'signin'): void =>
    storage.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ state, intent, returnTo: 'login' }))

  it('accepts an exact state match and spends the kept flow', () => {
    const s = memoryStore()
    keep(s)
    const r = parseGoogleReturn('?code=abc&state=good', s)
    expect(r).toEqual({
      kind: 'ok',
      flow: { state: 'good', intent: 'signin', returnTo: 'login' },
      code: 'abc',
      state: 'good'
    })
    expect(s.getItem(GOOGLE_FLOW_KEY)).toBeNull()
    // Replaying the same URL finds nothing kept.
    expect(parseGoogleReturn('?code=abc&state=good', s)).toEqual({ kind: 'no_flow' })
  })

  it('refuses a mismatched, missing or case-different state', () => {
    for (const q of ['?code=abc&state=evil', '?code=abc', '?state=good', '?code=abc&state=GOOD']) {
      const s = memoryStore()
      keep(s)
      expect(parseGoogleReturn(q, s).kind).toBe('invalid_state')
    }
  })

  it('treats any error return as a cancel and never needs the code', () => {
    const s = memoryStore()
    keep(s, 'good', 'reauth')
    const r = parseGoogleReturn('?error=access_denied&state=good', s)
    expect(r.kind).toBe('cancelled')
    expect(r.kind === 'cancelled' && r.flow.intent).toBe('reauth')
  })

  it('reports no flow for a garbage or absent kept value', () => {
    const s = memoryStore()
    expect(parseGoogleReturn('?code=a&state=b', s).kind).toBe('no_flow')
    s.setItem(GOOGLE_FLOW_KEY, '{not json')
    expect(parseGoogleReturn('?code=a&state=b', s).kind).toBe('no_flow')
    s.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ intent: 'signin' }))
    expect(parseGoogleReturn('?code=a&state=b', s).kind).toBe('no_flow')
  })

  it('falls back to signin for an unknown kept intent', () => {
    const s = memoryStore()
    s.setItem(GOOGLE_FLOW_KEY, JSON.stringify({ state: 'x', intent: 'admin' }))
    const r = parseGoogleReturn('?code=a&state=x', s)
    expect(r.kind === 'ok' && r.flow.intent).toBe('signin')
  })
})

describe('googleErrorText', () => {
  it('never shows the not_configured message (it names an env variable)', () => {
    const err = new ApiError(
      503,
      'ยังไม่ได้ตั้งค่า (GOOGLE_CLIENT_ID not set)',
      null,
      'not_configured'
    )
    const text = googleErrorText(err)
    expect(text).not.toMatch(/GOOGLE_|CLIENT_ID/)
  })

  it('shows the server Thai message for a known code', () => {
    const msg = 'บัญชี Google นี้เชื่อมต่อกับบัญชีอื่นอยู่แล้ว'
    expect(googleErrorText(new ApiError(409, msg, null, 'google_in_use'))).toBe(msg)
  })

  it('maps transport, throttle and uncoded failures to Thai', () => {
    expect(googleErrorText(new TypeError('Failed to fetch'))).toMatch(/เชื่อมต่อ/)
    expect(googleErrorText(new ApiError(0, 'x'))).toMatch(/เชื่อมต่อ/)
    expect(googleErrorText(new ApiError(429, 'Too Many Requests'))).toMatch(/บ่อยเกินไป/)
    expect(googleErrorText(new ApiError(500, 'Internal Server Error'))).not.toMatch(/Internal/)
    expect(googleErrorText(new ApiError(422, 'field required'))).not.toMatch(/field/)
  })
})

describe('outcome hand-off', () => {
  it('is peekable and taken exactly once', () => {
    stashGoogleOutcome({ kind: 'linked', googleEmail: 'a@b.c' })
    expect(peekGoogleOutcome()).toEqual({ kind: 'linked', googleEmail: 'a@b.c' })
    expect(takeGoogleOutcome()).toEqual({ kind: 'linked', googleEmail: 'a@b.c' })
    expect(takeGoogleOutcome()).toBeNull()
  })
})
