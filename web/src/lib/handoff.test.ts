import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StoredAuth } from '../platform/types'
import { ApiError, type Me, type TokenPair } from './api'
import {
  HANDOFF_BUSY_TEXT,
  HANDOFF_FAILED_TEXT,
  HANDOFF_OFFLINE_TEXT,
  adoptHandoffSession,
  captureHandoff,
  handleHandoff,
  isSameAccount,
  parseHandoffFragment,
  resetHandoffForTests,
  type HandoffDeps
} from './handoff'

const CODE = 'Abc_def-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' // 43 chars, the API's shape
const BASE = 'https://api.noey.test'

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown): string =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`
}

function profile(userId: number, email: string): Me {
  return {
    user_id: userId,
    email,
    tenant_id: userId,
    tenant_slug: `t${userId}`,
    role: 'owner',
    is_admin: false
  }
}

function pairFor(userId: number): TokenPair {
  return {
    access_token: jwt({ sub: String(userId), type: 'access', n: Math.random() }),
    refresh_token: jwt({ sub: String(userId), type: 'refresh', n: Math.random() }),
    token_type: 'bearer'
  }
}

function fakeHistory(): {
  replaceState: ReturnType<typeof vi.fn<(data: unknown, unused: string, url?: string) => void>>
  state: unknown
} {
  return {
    replaceState: vi.fn<(data: unknown, unused: string, url?: string) => void>(),
    state: { keep: true }
  }
}

function deps(over: Partial<HandoffDeps> = {}): HandoffDeps {
  return {
    redeem: vi.fn(async () => pairFor(7)),
    me: vi.fn(async () => profile(7, 'seven@example.com')),
    log: vi.fn(),
    ...over
  }
}

afterEach(() => resetHandoffForTests())

describe('parseHandoffFragment', () => {
  it('reads the code from #handoff=<code>', () => {
    expect(parseHandoffFragment(`#handoff=${CODE}`)).toBe(CODE)
  })

  it('is null when there is no handoff in the fragment', () => {
    expect(parseHandoffFragment('')).toBeNull()
    expect(parseHandoffFragment('#')).toBeNull()
    expect(parseHandoffFragment('#/dev/ui')).toBeNull()
  })

  it("is '' for an empty or malformed code (still a handoff, still stripped)", () => {
    expect(parseHandoffFragment('#handoff=')).toBe('')
    expect(parseHandoffFragment('#handoff=<script>')).toBe('')
    expect(parseHandoffFragment('#handoff=short')).toBe('')
  })
})

describe('captureHandoff', () => {
  it('strips the fragment from the address bar at once, keeping path and query', () => {
    const hist = fakeHistory()
    captureHandoff({ hash: `#handoff=${CODE}`, pathname: '/', search: '?x=1' }, hist)
    expect(hist.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/?x=1')
  })

  it('leaves a URL without a handoff alone', () => {
    const hist = fakeHistory()
    captureHandoff({ hash: '#/dev/ui', pathname: '/', search: '' }, hist)
    expect(hist.replaceState).not.toHaveBeenCalled()
  })
})

describe('handleHandoff', () => {
  it('is null when the page load carried no handoff', async () => {
    const d = deps()
    await expect(handleHandoff(BASE, d)).resolves.toBeNull()
    expect(d.redeem).not.toHaveBeenCalled()
  })

  it('redeems the captured code and returns a signed-in session', async () => {
    captureHandoff({ hash: `#handoff=${CODE}`, pathname: '/', search: '' }, fakeHistory())
    const d = deps()
    const boot = await handleHandoff(BASE, d)
    expect(d.redeem).toHaveBeenCalledWith(BASE, CODE)
    expect(boot?.signedIn?.profile.user_id).toBe(7)
    expect(boot?.loginError).toBeUndefined()
  })

  it('redeems once even when boot runs twice (StrictMode)', async () => {
    captureHandoff({ hash: `#handoff=${CODE}`, pathname: '/', search: '' }, fakeHistory())
    const d = deps()
    const [a, b] = await Promise.all([handleHandoff(BASE, d), handleHandoff(BASE, d)])
    expect(d.redeem).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('a malformed code never reaches the API and shows the login message', async () => {
    captureHandoff({ hash: '#handoff=nope', pathname: '/', search: '' }, fakeHistory())
    const d = deps()
    await expect(handleHandoff(BASE, d)).resolves.toEqual({ loginError: HANDOFF_FAILED_TEXT })
    expect(d.redeem).not.toHaveBeenCalled()
  })

  it.each([
    [new ApiError(401, 'expired'), HANDOFF_FAILED_TEXT],
    [new ApiError(429, 'slow down'), HANDOFF_BUSY_TEXT],
    [new ApiError(0, 'offline'), HANDOFF_OFFLINE_TEXT],
    [new Error('boom'), HANDOFF_FAILED_TEXT]
  ])('a failed redeem (%s) falls back to the login screen', async (err, text) => {
    captureHandoff({ hash: `#handoff=${CODE}`, pathname: '/', search: '' }, fakeHistory())
    const d = deps({ redeem: vi.fn(async () => Promise.reject(err)) })
    await expect(handleHandoff(BASE, d)).resolves.toEqual({ loginError: text })
    // The code is never logged.
    expect(JSON.stringify((d.log as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(CODE)
  })
})

describe('adoptHandoffSession', () => {
  function stored(userId: number, email: string): StoredAuth {
    const pair = pairFor(userId)
    return {
      baseUrl: BASE,
      email,
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token
    }
  }

  function adoptDeps(current: StoredAuth | null): {
    load: Mock<() => Promise<StoredAuth | null>>
    save: Mock<(value: StoredAuth) => Promise<void>>
    clear: Mock<() => Promise<void>>
    revoke: Mock<(baseUrl: string, access: string, refresh: string) => Promise<void>>
    forgetWorker: Mock<() => void>
  } {
    return {
      load: vi.fn(async () => current),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      forgetWorker: vi.fn()
    }
  }

  const incoming = (): { accessToken: string; refreshToken: string; profile: Me } => {
    const pair = pairFor(7)
    return {
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
      profile: profile(7, 'seven@example.com')
    }
  }

  it('stores the session like a login when nothing was stored', async () => {
    const d = adoptDeps(null)
    const next = incoming()
    await adoptHandoffSession(BASE, next, d)
    expect(d.save).toHaveBeenCalledWith({
      baseUrl: BASE,
      email: 'seven@example.com',
      accessToken: next.accessToken,
      refreshToken: next.refreshToken
    })
    expect(d.revoke).not.toHaveBeenCalled()
  })

  it('a different account stored here is signed out first — the handoff wins', async () => {
    const old = stored(3, 'three@example.com')
    const d = adoptDeps(old)
    await adoptHandoffSession(BASE, incoming(), d)
    expect(d.revoke).toHaveBeenCalledWith(BASE, old.accessToken, old.refreshToken)
    expect(d.clear).toHaveBeenCalled()
    expect(d.forgetWorker).toHaveBeenCalled()
    expect(d.save).toHaveBeenCalledTimes(1)
    expect(d.clear.mock.invocationCallOrder[0]).toBeLessThan(d.save.mock.invocationCallOrder[0])
  })

  it('the same account is replaced without revoking (an open editor tab keeps working)', async () => {
    const d = adoptDeps(stored(7, 'seven@example.com'))
    await adoptHandoffSession(BASE, incoming(), d)
    expect(d.revoke).not.toHaveBeenCalled()
    expect(d.clear).not.toHaveBeenCalled()
    expect(d.save).toHaveBeenCalledTimes(1)
  })
})

describe('isSameAccount', () => {
  it('compares the token subject, then falls back to the email', () => {
    const p = profile(7, 'Seven@Example.com')
    const access = pairFor(7).access_token
    const mine = { baseUrl: BASE, email: 'x', accessToken: jwt({ sub: '7' }), refreshToken: '' }
    const other = {
      baseUrl: BASE,
      email: 'seven@example.com',
      accessToken: jwt({ sub: '8' }),
      refreshToken: ''
    }
    const opaque = {
      baseUrl: BASE,
      email: 'seven@example.com',
      accessToken: 'x',
      refreshToken: 'y'
    }
    expect(isSameAccount(mine, access, p)).toBe(true)
    expect(isSameAccount(other, access, p)).toBe(false)
    expect(isSameAccount(opaque, access, p)).toBe(true)
  })
})
