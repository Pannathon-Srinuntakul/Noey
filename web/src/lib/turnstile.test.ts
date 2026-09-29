import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TURNSTILE_SCRIPT_URL,
  isCaptchaCode,
  loadTurnstile,
  resetTurnstileLoader,
  turnstileSiteKey,
  type TurnstileApi,
  type TurnstileHost
} from './turnstile'

describe('captcha codes', () => {
  it('only the two bot-check refusals open the widget', () => {
    expect(isCaptchaCode('captcha_required')).toBe(true)
    expect(isCaptchaCode('captcha_failed')).toBe(true)
    expect(isCaptchaCode('invalid_state')).toBe(false)
    expect(isCaptchaCode(null)).toBe(false)
    expect(isCaptchaCode(undefined)).toBe(false)
  })
})

describe('site key', () => {
  it('is off when unset or blank, trimmed otherwise', () => {
    expect(turnstileSiteKey(undefined)).toBe('')
    expect(turnstileSiteKey('   ')).toBe('')
    expect(turnstileSiteKey(' 0x4AAA ')).toBe('0x4AAA')
  })

  it('this test build has none, so the login screen never shows a widget', () => {
    expect(turnstileSiteKey()).toBe('')
  })
})

/** A script element stand-in: records listeners, fires them on demand. */
function fakeScript(): HTMLScriptElement & { fire: (type: 'load' | 'error') => void } {
  const listeners = new Map<string, () => void>()
  const el = {
    id: '',
    src: '',
    async: false,
    defer: false,
    removed: false,
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    remove() {
      this.removed = true
    },
    fire: (type: string) => listeners.get(type)?.()
  }
  return el as unknown as HTMLScriptElement & { fire: (type: 'load' | 'error') => void }
}

function fakeHost(): TurnstileHost & {
  api: TurnstileApi | undefined
  appended: ReturnType<typeof fakeScript>[]
} {
  const host = {
    api: undefined as TurnstileApi | undefined,
    appended: [] as ReturnType<typeof fakeScript>[],
    getApi: () => host.api,
    findScript: () =>
      host.appended.find((s) => !(s as unknown as { removed: boolean }).removed) ?? null,
    appendScript: (s: HTMLScriptElement) =>
      void host.appended.push(s as ReturnType<typeof fakeScript>),
    createScript: () => fakeScript()
  }
  return host
}

const API: TurnstileApi = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() }

describe('loadTurnstile', () => {
  beforeEach(() => resetTurnstileLoader())

  it("injects Cloudflare's explicit-render script once and resolves with its API", async () => {
    const host = fakeHost()
    const a = loadTurnstile(host)
    const b = loadTurnstile(host)
    expect(host.appended).toHaveLength(1)
    expect(host.appended[0].src).toBe(TURNSTILE_SCRIPT_URL)
    expect(TURNSTILE_SCRIPT_URL).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    )
    host.api = API
    host.appended[0].fire('load')
    await expect(a).resolves.toBe(API)
    await expect(b).resolves.toBe(API)
  })

  it('resolves at once when the API is already on the page', async () => {
    const host = fakeHost()
    host.api = API
    await expect(loadTurnstile(host)).resolves.toBe(API)
    expect(host.appended).toHaveLength(0)
  })

  it('a failed load is not cached: the next mount tries again', async () => {
    const host = fakeHost()
    const first = loadTurnstile(host)
    host.appended[0].fire('error')
    await expect(first).rejects.toThrow()
    const second = loadTurnstile(host)
    expect(host.appended).toHaveLength(2)
    host.api = API
    host.appended[1].fire('load')
    await expect(second).resolves.toBe(API)
  })
})

describe('CSP', () => {
  it('index.html lets the Turnstile origin in only through the build-time placeholder', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toMatch(/script-src [^;]*%TURNSTILE_ORIGIN%/)
    expect(csp).toMatch(/frame-src 'self' %TURNSTILE_ORIGIN%/)
    expect(csp).not.toContain('challenges.cloudflare.com')
  })
})
