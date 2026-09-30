/**
 * Arriving from the account site already signed in — the editor half of the
 * sign-in handoff (docs/auth-handoff.md).
 *
 * The site's "เปิดห้องตัดต่อ" button goes through its server, which mints a
 * one-time code as the signed-in user and sends the browser to
 * `<editor>/#handoff=<code>`. The code rides in the FRAGMENT so it never
 * reaches a server log or a Referer header. It is single use and dies in
 * 60 s, but it is still a credential until spent, so:
 *
 *   1. `captureHandoff()` runs first thing in main.tsx — before error
 *      monitoring instruments history and before React renders — and strips
 *      the fragment from the address bar (history.replaceState), keeping the
 *      code in module memory only. A reload or Back never sees it again.
 *   2. App's boot calls `handleHandoff()` (memoised: StrictMode runs the boot
 *      effect twice, and a code works once) to redeem it for an ordinary
 *      pair, then `adoptHandoffSession()` stores it exactly like a login.
 *   3. The handoff WINS over a session already stored for a DIFFERENT
 *      account: that one is revoked on the server and forgotten here. A
 *      stored session of the SAME account is simply replaced (not revoked: an
 *      editor tab already open on it keeps working).
 *   4. Any failure lands on the login screen with a short Thai line. Nothing
 *      throws out of here.
 */

import type { StoredAuth } from '../platform/types'
import { ApiError, logout, me, redeemHandoff, type Me, type TokenPair } from './api'
import { decodeJwtPayload } from './jwt'

export const HANDOFF_FRAGMENT_KEY = 'handoff'

export const HANDOFF_FAILED_TEXT =
  'ลิงก์เข้าสู่ระบบจากหน้าเว็บหมดอายุหรือถูกใช้ไปแล้ว — กรุณาเข้าสู่ระบบอีกครั้ง'
export const HANDOFF_OFFLINE_TEXT =
  'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วเข้าสู่ระบบอีกครั้ง'
export const HANDOFF_BUSY_TEXT = 'ลองบ่อยเกินไป — รอสักครู่แล้วเข้าสู่ระบบอีกครั้ง'

/** The shape the API mints (`secrets.token_urlsafe(32)`, 43 chars). */
const CODE_RE = /^[A-Za-z0-9_-]{20,128}$/

/**
 * The code in a `#handoff=<code>` fragment. `null` when the fragment has no
 * handoff at all; `''` when it has one that is empty or malformed (still
 * stripped, and reported as a failed handoff).
 */
export function parseHandoffFragment(hash: string): string | null {
  if (!hash || hash.length < 2) return null
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  if (!params.has(HANDOFF_FRAGMENT_KEY)) return null
  const code = params.get(HANDOFF_FRAGMENT_KEY) ?? ''
  return CODE_RE.test(code) ? code : ''
}

type LocationLike = Pick<Location, 'hash' | 'pathname' | 'search'>
type HistoryLike = Pick<History, 'replaceState' | 'state'>

let captured: string | null = null
let once: Promise<HandoffBoot | null> | null = null

/**
 * Take the code out of the address bar. Call once, before anything else can
 * read or record the URL. A no-op when the page load carries no handoff.
 */
export function captureHandoff(
  loc: LocationLike = window.location,
  hist: HistoryLike = window.history
): void {
  const code = parseHandoffFragment(loc.hash)
  if (code === null) return
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`)
  captured = code
}

export interface HandoffBoot {
  signedIn?: { accessToken: string; refreshToken: string; profile: Me }
  loginError?: string
}

export interface HandoffDeps {
  redeem: (baseUrl: string, code: string) => Promise<TokenPair>
  me: (baseUrl: string, accessToken: string) => Promise<Me>
  log: (message: string) => void
}

const defaultDeps = (): HandoffDeps => ({
  redeem: redeemHandoff,
  me,
  log: (message) => void window.noey.log.write('handoff', message)
})

export function handoffErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return HANDOFF_OFFLINE_TEXT
    if (err.status === 429) return HANDOFF_BUSY_TEXT
  }
  return HANDOFF_FAILED_TEXT
}

/** Null when this page load did not arrive with a handoff. */
export function handleHandoff(
  baseUrl: string,
  deps: HandoffDeps = defaultDeps()
): Promise<HandoffBoot | null> {
  if (captured === null) return Promise.resolve(null)
  const code = captured
  once ??= run(baseUrl, code, deps)
  return once
}

async function run(baseUrl: string, code: string, deps: HandoffDeps): Promise<HandoffBoot> {
  if (!code) return { loginError: HANDOFF_FAILED_TEXT }
  try {
    const pair = await deps.redeem(baseUrl, code)
    const profile = await deps.me(baseUrl, pair.access_token)
    return {
      signedIn: { accessToken: pair.access_token, refreshToken: pair.refresh_token, profile }
    }
  } catch (err) {
    // The code itself never goes into the log.
    deps.log(`redeem failed: ${err instanceof ApiError ? `HTTP ${err.status}` : String(err)}`)
    return { loginError: handoffErrorText(err) }
  }
}

function subjectOf(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub
  return sub === undefined || sub === null ? null : String(sub)
}

/** Whether a stored session belongs to the same account as the new one. */
export function isSameAccount(stored: StoredAuth, accessToken: string, profile: Me): boolean {
  const before = subjectOf(stored.accessToken) ?? subjectOf(stored.refreshToken)
  if (before !== null)
    return before === String(profile.user_id) || before === subjectOf(accessToken)
  return stored.email.trim().toLowerCase() === profile.email.trim().toLowerCase()
}

export interface AdoptDeps {
  load: () => Promise<StoredAuth | null>
  save: (value: StoredAuth) => Promise<void>
  clear: () => Promise<void>
  /** Best effort, never throws (api.ts `logout`). */
  revoke: (baseUrl: string, accessToken: string, refreshToken: string) => Promise<void>
  /** The service worker holds the old token and file map (App.tsx). */
  forgetWorker: () => void
}

/**
 * Store the handed-off session the way a login does. A session already
 * stored for ANOTHER account is signed out first — on the server (its refresh
 * token revoked) and here (storage, service worker). Store ownership (the
 * per-account browser project store) is App's `ensureStoreOwner`, run after.
 */
export async function adoptHandoffSession(
  baseUrl: string,
  signedIn: NonNullable<HandoffBoot['signedIn']>,
  deps?: Partial<AdoptDeps>
): Promise<void> {
  const d: AdoptDeps = {
    load: () => window.noey.auth.load(),
    save: (value) => window.noey.auth.save(value),
    clear: () => window.noey.auth.clear(),
    revoke: logout,
    forgetWorker: () => undefined,
    ...deps
  }
  const stored = await d.load().catch(() => null)
  if (stored && !isSameAccount(stored, signedIn.accessToken, signedIn.profile)) {
    void d.revoke(baseUrl, stored.accessToken, stored.refreshToken)
    await d.clear()
    d.forgetWorker()
  }
  await d.save({
    baseUrl,
    email: signedIn.profile.email,
    accessToken: signedIn.accessToken,
    refreshToken: signedIn.refreshToken
  })
}

/** Tests only: forget the captured code and the memoised run. */
export function resetHandoffForTests(): void {
  captured = null
  once = null
}
