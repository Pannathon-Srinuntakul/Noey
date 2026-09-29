/**
 * Sign in with Google — the browser half of the backend's OAuth flow.
 *
 * There is NO Google JavaScript library here and none is needed: the backend
 * builds the authorization URL (PKCE S256 + nonce, verifier kept server-side),
 * the page navigates the TOP window to it, and Google sends the browser back
 * to `<origin>/auth/google/callback?code=…&state=…`. The page's only security
 * job is login-CSRF binding: keep the `state` it was handed in sessionStorage
 * (this tab only) and refuse a return whose `state` does not match exactly.
 *
 * Contract: docs/google-sign-in.md (backend/services/api/routers/auth_google.py).
 * Google's redirect-back shape (`?code=&state=` on success, `?error=access_denied`
 * when the person cancels, other `error` values possible) is from
 * https://developers.google.com/identity/protocols/oauth2/web-server
 * ("Step 5: Handle the OAuth 2.0 server response"), fetched 2026-09-30.
 *
 * Nothing in the URL is ever sent to the API on an `error` return, and the
 * query (which carries a one-time code) is stripped from the address bar by
 * the caller before anything else runs.
 */

import { ApiError, googleStart, type GoogleIntent } from './api'

/** The path every web-editor redirect URI ends in. The owner registers
 * `<editor origin>` + this, verbatim, in GOOGLE_REDIRECT_URIS AND in Google
 * Cloud Console. nginx's SPA fallback serves index.html for it. */
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback'

/** sessionStorage key — per tab, gone when the tab closes. */
export const GOOGLE_FLOW_KEY = 'noey.google'

export interface GoogleFlow {
  state: string
  intent: GoogleIntent
  /** Where the app should land afterwards (only 'settings' is used today). */
  returnTo: 'login' | 'settings'
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}`
}

export function isGoogleCallbackPath(pathname: string): boolean {
  return pathname === GOOGLE_CALLBACK_PATH
}

/**
 * Start a flow: ask the API for the authorization URL, remember `state` in
 * this tab, then leave for Google. Never a popup or an iframe — a top-level
 * navigation is the design (the API never sees the browser's cookies).
 */
export async function beginGoogle(opts: {
  baseUrl: string
  origin: string
  intent: GoogleIntent
  returnTo: GoogleFlow['returnTo']
  accessToken?: string
  storage?: KeyValueStore
  navigate?: (url: string) => void
  /** Injected by tests; the real API call otherwise. */
  start?: typeof googleStart
}): Promise<void> {
  const storage = opts.storage ?? window.sessionStorage
  const navigate = opts.navigate ?? ((url: string) => window.location.assign(url))
  const start = opts.start ?? googleStart
  const res = await start(
    opts.baseUrl,
    { redirect_uri: googleRedirectUri(opts.origin), intent: opts.intent },
    opts.accessToken
  )
  const flow: GoogleFlow = { state: res.state, intent: opts.intent, returnTo: opts.returnTo }
  storage.setItem(GOOGLE_FLOW_KEY, JSON.stringify(flow))
  navigate(res.authorization_url)
}

export type GoogleReturn =
  /** Nothing kept in this tab — a bookmarked/reloaded callback URL, or a
   * flow started in another tab. Treated like a state mismatch. */
  | { kind: 'no_flow' }
  | { kind: 'cancelled'; flow: GoogleFlow }
  | { kind: 'invalid_state'; flow: GoogleFlow }
  | { kind: 'ok'; flow: GoogleFlow; code: string; state: string }

function readFlow(storage: KeyValueStore): GoogleFlow | null {
  let raw: string | null = null
  try {
    raw = storage.getItem(GOOGLE_FLOW_KEY)
    storage.removeItem(GOOGLE_FLOW_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const f = JSON.parse(raw) as Partial<GoogleFlow>
    if (typeof f.state !== 'string' || !f.state) return null
    const intent: GoogleIntent = f.intent === 'link' || f.intent === 'reauth' ? f.intent : 'signin'
    const returnTo: GoogleFlow['returnTo'] = f.returnTo === 'settings' ? 'settings' : 'login'
    return { state: f.state, intent, returnTo }
  } catch {
    return null
  }
}

/**
 * Read Google's answer from the callback query. The kept flow is removed in
 * every case (it is single-use), and the state comparison is exact.
 */
export function parseGoogleReturn(search: string, storage?: KeyValueStore): GoogleReturn {
  const flow = readFlow(storage ?? window.sessionStorage)
  if (!flow) return { kind: 'no_flow' }
  const q = new URLSearchParams(search)
  if (q.get('error')) return { kind: 'cancelled', flow }
  const code = q.get('code') ?? ''
  const state = q.get('state') ?? ''
  if (!code || !state || state !== flow.state) return { kind: 'invalid_state', flow }
  return { kind: 'ok', flow, code, state }
}

export const GOOGLE_CANCELLED_TEXT = 'ยกเลิกการเข้าสู่ระบบด้วย Google แล้ว'
export const GOOGLE_INVALID_STATE_TEXT =
  'การเข้าสู่ระบบด้วย Google หมดเวลาหรือถูกใช้ไปแล้ว — กรุณาเริ่มใหม่อีกครั้ง'

/**
 * Thai text for a failed Google call. The server's own `message` is Thai and
 * safe to show — except `not_configured`, whose message names the missing
 * environment variable, so a generic line replaces it.
 */
export function googleErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่'
  if (err.status === 0) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่'
  if (err.code === 'not_configured') return 'ยังไม่เปิดให้เข้าสู่ระบบด้วย Google ในขณะนี้'
  if (err.code === 'store_unavailable' || (err.status >= 500 && !err.code))
    return 'เซิร์ฟเวอร์มีปัญหาชั่วคราว — ลองใหม่อีกครั้ง'
  if (err.status === 429) return 'ลองบ่อยเกินไป — รอสักครู่แล้วลองใหม่'
  if (err.code === 'redirect_uri_not_allowed' || err.code === 'redirect_uri_mismatch')
    return 'หน้านี้ยังไม่ได้ลงทะเบียนสำหรับเข้าสู่ระบบด้วย Google — แจ้งผู้ดูแลระบบ'
  if (err.code && err.detail) return err.detail
  return 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ — ลองใหม่อีกครั้ง'
}

// ── hand-off from the callback to the account screen ────────────────────────
// A link / reauth return lands on a fresh page load: App completes the call,
// then the account tab (mounted later, deep inside the router) picks up what
// happened. Module state, read once.

export type GoogleOutcome =
  | { kind: 'linked'; googleEmail: string }
  | { kind: 'reauth'; reauthToken: string; expiresAt: number }
  | { kind: 'error'; intent: GoogleIntent; message: string }

let pendingOutcome: GoogleOutcome | null = null

export function stashGoogleOutcome(outcome: GoogleOutcome): void {
  pendingOutcome = outcome
}

export function takeGoogleOutcome(): GoogleOutcome | null {
  const o = pendingOutcome
  pendingOutcome = null
  return o
}

export function peekGoogleOutcome(): GoogleOutcome | null {
  return pendingOutcome
}
