/**
 * Cloudflare Turnstile — the bot check the backend asks for before a Google
 * sign-in may CREATE an account (backend/packages/auth/turnstile.py,
 * routers/auth_google.py). Mirrors noey-frontend's TurnstileWidget.
 *
 * How the backend decides (auth_google.py `google_start` / `_signin`):
 *   - TURNSTILE_SECRET_KEY unset → every start is `captcha_ok`, nothing needed.
 *   - set, `turnstile_token` sent to POST /auth/google/start (intent signin) →
 *     verified THERE (tokens live 300 s, Google's round trip may not); a bad
 *     token is 400 `captcha_failed` at once.
 *   - set, no token → the start still succeeds (a returning user needs none),
 *     but a callback that would create a NEW account answers 400
 *     `captcha_required`. The login screen then shows the widget for the retry.
 *
 * The site key is public and build-time (VITE_TURNSTILE_SITE_KEY). Unset = no
 * widget, no third-party script and no CSP entry (vite.config.ts).
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'
/** `render=explicit`: the SPA mounts the widget itself, after navigation too. */
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`
const SCRIPT_ID = 'noey-turnstile-api'

/** The two backend codes that mean "show the widget and try again". */
const CAPTCHA_CODES = new Set(['captcha_required', 'captcha_failed'])

export function isCaptchaCode(code: string | null | undefined): boolean {
  return !!code && CAPTCHA_CODES.has(code)
}

/** Trimmed site key, or '' (off). */
export function turnstileSiteKey(
  raw: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY
): string {
  return (raw ?? '').trim()
}

export interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** The bits of `document` / `window` the loader touches — injectable for tests. */
export interface TurnstileHost {
  getApi: () => TurnstileApi | undefined
  findScript: () => HTMLScriptElement | null
  appendScript: (script: HTMLScriptElement) => void
  createScript: () => HTMLScriptElement
}

function browserHost(): TurnstileHost {
  return {
    getApi: () => window.turnstile,
    findScript: () => document.getElementById(SCRIPT_ID) as HTMLScriptElement | null,
    appendScript: (s) => void document.head.appendChild(s),
    createScript: () => document.createElement('script')
  }
}

let pending: Promise<TurnstileApi> | null = null

/**
 * Load Cloudflare's script once per page and resolve with its API. A failed
 * load is not cached, so the next widget mount tries again.
 */
export function loadTurnstile(host: TurnstileHost = browserHost()): Promise<TurnstileApi> {
  const ready = host.getApi()
  if (ready) return Promise.resolve(ready)
  if (pending) return pending
  pending = new Promise<TurnstileApi>((resolve, reject) => {
    const fail = (): void => {
      pending = null
      host.findScript()?.remove()
      reject(new Error('turnstile script failed to load'))
    }
    const done = (): void => {
      const api = host.getApi()
      if (api) resolve(api)
      else fail()
    }
    let script = host.findScript()
    if (!script) {
      script = host.createScript()
      script.id = SCRIPT_ID
      script.src = TURNSTILE_SCRIPT_URL
      script.async = true
      script.defer = true
      host.appendScript(script)
    }
    script.addEventListener('load', done, { once: true })
    script.addEventListener('error', fail, { once: true })
  })
  return pending
}

/** Tests only: forget a cached load. */
export function resetTurnstileLoader(): void {
  pending = null
}
