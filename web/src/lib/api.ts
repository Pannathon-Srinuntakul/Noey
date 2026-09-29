/** Backend API client — same endpoints as the web app, but with the desktop
 * app's own JWT session (no session sharing with the browser). */

import { isTokenExpired } from './jwt'
import { apiFetch } from './httpClient'
import { responseErrorDetail } from './apiError'
import {
  parseRefusal,
  refusalMessage,
  type BillingRefusal,
  type LimitKey,
  type UsageLimit
} from './usageLimits'

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
  /** Additive fields (backend 2026-09-30). Optional: an older server omits
   * them, and the account screen then offers the password path only. */
  has_password?: boolean
  google_linked?: boolean
  google_email?: string | null
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    /** Set when the server refused to start (or stopped) paid work — a limit,
     * the free tier, a paused service. The UI branches on it (continue with
     * the balance, show the reset time) instead of parsing `detail`. */
    public refusal: BillingRefusal | null = null,
    /** The machine-readable `detail.code` the account and Google routes send
     * (`{code, message}`). Branch on this, never on the Thai message. */
    public code: string | null = null,
    /** The whole `detail` object when it was one — carries extras such as
     * `balance_satang` on a 409 `wallet_balance`. */
    public extra: Record<string, unknown> | null = null
  ) {
    super(detail)
  }
}

/** `detail.code` / the detail object of a `{detail: {code, message, ...}}` body. */
export function detailObject(body: unknown): Record<string, unknown> | null {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  return detail as Record<string, unknown>
}

/**
 * The `ApiError` for a failed response. A billing refusal carries an object
 * `detail` whose own message cannot name the viewer's local reset time, so it
 * is worded here (`refusalMessage`) rather than taken from the server.
 */
export function errorFromResponse(res: { status: number; json: () => unknown }): ApiError {
  let body: unknown = null
  try {
    body = res.json()
  } catch {
    /* non-JSON body — responseErrorDetail decides from the status */
  }
  const refusal = parseRefusal(body)
  if (refusal) return new ApiError(res.status, refusalMessage(refusal), refusal)
  const obj = detailObject(body)
  const code = typeof obj?.code === 'string' ? obj.code : null
  return new ApiError(res.status, responseErrorDetail(res), null, code, obj)
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Message for a request that never produced a response.
 *
 * Not everything that throws here is a network problem. The bridge in the main
 * process can fail on its own before a packet leaves the machine — 0.1.11
 * shipped a RangeError from `AbortSignal.timeout()` that killed every upload in
 * 27ms, and the flat "เชื่อมต่อ server ไม่ได้" sent everyone hunting the Wi-Fi
 * and the server instead. Anything that is not a plain connection failure now
 * says what it actually was.
 */
export function connectErrorMessage(err: unknown): string {
  const offline = 'เชื่อมต่อ server ไม่ได้ ลองใหม่อีกครั้ง'
  const name = (err as { name?: string })?.name ?? ''
  const message = (err as { message?: string })?.message ?? ''
  if (name === 'TimeoutError') return 'server ไม่ตอบกลับ (หมดเวลา) — ลองใหม่อีกครั้ง'
  // Node's fetch reports a genuine connection failure as TypeError.
  if (!name || name === 'TypeError' || name === 'AbortError') return offline
  return `${offline} (${name}${message ? `: ${message.slice(0, 120)}` : ''})`
}

async function request<T>(baseUrl: string, path: string, init?: ApiFetchInit): Promise<T> {
  let res
  try {
    res = await apiFetch(apiUrl(baseUrl, path), init)
  } catch (err) {
    void window.noey.log.write('api', `fetch failed ${baseUrl}${path}: ${String(err)}`)
    throw new ApiError(0, connectErrorMessage(err))
  }
  if (!res.ok) throw errorFromResponse(res)
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

/**
 * `POST /auth/logout` — revoke the refresh token server-side.
 *
 * Best effort by contract: the local sign-out happens whether or not this
 * lands, so a server that predates the route (404), an already-dead access
 * token (401) or no network at all must not keep the user signed in. Only
 * the log records the miss.
 */
export async function logout(
  baseUrl: string,
  accessToken: string,
  refreshToken: string
): Promise<void> {
  const revoke = (access: string, refreshTok: string): Promise<void> =>
    request<void>(baseUrl, '/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}` },
      body: JSON.stringify({ refresh_token: refreshTok })
    })
  try {
    await revoke(accessToken, refreshToken)
  } catch (err) {
    // The access token has lapsed (an idle tab signing out): the refresh
    // token is still live, and it is the one that matters. Spend it on a
    // new pair and revoke that — through the single-flight helper, and by
    // dynamic import because it imports `refresh` from here.
    if (err instanceof ApiError && err.status === 401 && !isTokenExpired(refreshToken)) {
      try {
        const { refreshOnce } = await import('./tokenRefresh')
        const pair = await refreshOnce({ baseUrl, refreshToken })
        await revoke(pair.access_token, pair.refresh_token)
        return
      } catch (again) {
        void window.noey.log.write('api', `logout not acknowledged: ${String(again)}`)
        return
      }
    }
    void window.noey.log.write('api', `logout not acknowledged: ${String(err)}`)
  }
}

export function me(baseUrl: string, accessToken: string): Promise<Me> {
  return request<Me>(baseUrl, '/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

/** One of `packages/llm/usage.py USAGE_TASKS`. */
export type UsageTask = 'cut' | 'effects' | 'style' | 'other'

export interface UsageByTask {
  task: UsageTask
  /** Share of the current window's usage, already rounded by the server. */
  pct: number
}

/**
 * `GET /usage/me` (docs/token-billing-design.md §19). Percentages, reset
 * times, a baht balance — the server sends no token count, and this type
 * deliberately has nowhere to put one.
 */
export interface Usage {
  plan: string
  unlimited: boolean
  /** The plan's ENFORCED windows: Free monthly; Lite/Starter weekly; Pro and
   * up weekly + 5-hour. Empty for an unlimited account. */
  limits: UsageLimit[]
  /** The fullest window has no room left: a start then needs the balance. */
  blocked: { key: LimitKey; resets_at: string | null; resets?: boolean } | null
  concurrency: { max: number; running: number; queued: number }
  /** Null until the first top-up. */
  wallet: { balance_satang: number; next_expiry: string | null } | null
  /** `quota_bytes` 0 = unlimited. */
  storage: { used_bytes: number; quota_bytes: number }
  pending_plan: { plan: string; at: string | null } | null
  grace_until: string | null
  by_task: UsageByTask[]
  /** What the plan includes (docs/token-billing-plan.md §8). Optional: an
   * older server does not send it, and nothing is locked then. */
  features?: PlanFeatures
  /** Projects kept on the account; `max` null = unlimited. */
  projects?: { count: number; max: number | null }
}

/** Per-plan features the pricing page promises. Null limits = unlimited. */
export interface PlanFeatures {
  /**
   * Roughly how many cuts a month the plan buys — MARKETING COPY, never
   * subtracted from. Nothing counts down from it and no meter may read it;
   * the quota is the percentage in `limits`. (Renamed from `clips` by the
   * server, 2026-09-29, for exactly that reason.)
   */
  approx_cuts?: number | null
  footage_sec: number | null
  max_projects: number | null
  music: boolean
  transcode: boolean
  music_min_plan: string
  transcode_min_plan: string
  queue: 'normal' | 'ahead' | 'first'
}

/** `GET /billing/plans` — public monthly prices in satang. */
export interface PlanPrices {
  source: 'stripe' | 'mock'
  plans: { tier: string; unit_amount: number }[]
}

export function getPlanPrices(baseUrl: string): Promise<PlanPrices> {
  return request<PlanPrices>(baseUrl, '/billing/plans')
}

/** `POST /billing/plan-preview` — what the confirm dialog shows. */
export interface PlanChangePreview {
  tier: string
  current: string
  direction: 'upgrade' | 'downgrade' | 'same'
  due_now_satang: number
  next_price_satang: number
  effective_at: string | null
  mode: 'checkout' | 'stripe_change' | 'stripe_cancel' | 'mock' | 'unavailable'
  exact: boolean
}

export function previewPlanChange(
  baseUrl: string,
  accessToken: string,
  tier: string
): Promise<PlanChangePreview> {
  return request<PlanChangePreview>(baseUrl, '/billing/plan-preview', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ tier })
  })
}

/** `POST /billing/plan-switch` — a page to open (checkout / confirm), or
 * `applied` when the change is already made or scheduled. The server checks
 * `consent` itself for any paid plan. */
export function switchPlan(
  baseUrl: string,
  accessToken: string,
  tier: string,
  consent: boolean
): Promise<{ url: string | null; applied: boolean; effective_at: string | null }> {
  return request(baseUrl, '/billing/plan-switch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ tier, consent })
  })
}

export function getUsage(baseUrl: string, accessToken: string): Promise<Usage> {
  return request<Usage>(baseUrl, '/usage/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

/** `GET /wallet/me` — the top-up balance in satang (฿ = satang / 100). */
export interface Wallet {
  balance_satang: number
  /** Held by runs still in flight; not spendable until they settle. */
  reserved_satang: number
  lots: { remaining_satang: number; expires_at: string }[]
  history: {
    kind: 'purchase' | 'debit' | 'refund' | 'expire' | 'adjust' | 'reversal'
    amount_satang: number
    created_at: string
  }[]
  packs: number[]
  methods: string[]
}

export function getWallet(baseUrl: string, accessToken: string): Promise<Wallet> {
  return request<Wallet>(baseUrl, '/wallet/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

/** Start a top-up. The answer is a checkout page to open — or, on a local
 * server with no payment provider, the return URL of a top-up already
 * credited (`checkoutAlreadyCredited`). */
export function startTopup(
  baseUrl: string,
  accessToken: string,
  packSatang: number,
  method: string
): Promise<{ url: string }> {
  return request<{ url: string }>(baseUrl, '/wallet/checkout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ pack_satang: packSatang, method })
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
    // Through the single-flight helper, so a boot-time restore and a 401
    // elsewhere never present the same refresh token twice (tokenRefresh.ts).
    // Dynamic: that module imports `refresh` from here.
    const { refreshOnce } = await import('./tokenRefresh')
    const pair = await refreshOnce({ baseUrl, refreshToken })
    return { access_token: pair.access_token, refresh_token: pair.refresh_token }
  } catch {
    return null
  }
}

// ── Google sign-in + account deletion (backend contract 2026-09-30) ─────────
// docs/google-sign-in.md. Every route answers errors as
// `detail: {code, message}` — callers branch on `ApiError.code`.

export type GoogleIntent = 'signin' | 'link' | 'reauth'

/** `GET /auth/google/config` — public; `enabled` false until the server has
 * GOOGLE_CLIENT_ID / _SECRET / _REDIRECT_URIS. Never 503. */
export function googleConfig(
  baseUrl: string
): Promise<{ enabled: boolean; redirect_uris: string[] }> {
  return request(baseUrl, '/auth/google/config')
}

/** `POST /auth/google/start` — link/reauth need the caller's access token. */
export function googleStart(
  baseUrl: string,
  body: { redirect_uri: string; intent: GoogleIntent },
  accessToken?: string
): Promise<{ authorization_url: string; state: string; expires_in: number }> {
  return request(baseUrl, '/auth/google/start', {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: JSON.stringify(body)
  })
}

export type GoogleCallbackResult =
  | (TokenPair & { intent: 'signin'; created: boolean; linked: boolean })
  | { intent: 'link'; google_email: string }
  | { intent: 'reauth'; reauth_token: string; expires_in: number }

/** `POST /auth/google/callback` — spends the state; link/reauth need the SAME
 * user's access token as /start. */
export function googleCallback(
  baseUrl: string,
  body: { code: string; state: string; redirect_uri: string },
  accessToken?: string
): Promise<GoogleCallbackResult> {
  return request(baseUrl, '/auth/google/callback', {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: JSON.stringify(body)
  })
}

/** `DELETE /auth/google` — 409 `password_required` while there is no password. */
export function googleUnlink(baseUrl: string, accessToken: string): Promise<void> {
  return request<void>(baseUrl, '/auth/google', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

/** `POST /auth/delete-account` — 204 on success; every token is dead after it. */
export function deleteAccount(
  baseUrl: string,
  accessToken: string,
  body: { password?: string; reauth_token?: string; forfeit_wallet_balance?: boolean }
): Promise<void> {
  return request<void>(baseUrl, '/auth/delete-account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body)
  })
}
