/** Backend API client — same endpoints as the web app, but with the desktop
 * app's own JWT session (no session sharing with the browser). */

import { isTokenExpired } from './jwt'
import { apiFetch } from './httpClient'
import { apiErrorDetail } from './apiError'
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
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    /** Set when the server refused to start (or stopped) paid work — a limit,
     * the free tier, a paused service. The UI branches on it (continue with
     * the balance, show the reset time) instead of parsing `detail`. */
    public refusal: BillingRefusal | null = null
  ) {
    super(detail)
  }
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
  let detail = `HTTP ${res.status}`
  try {
    detail = apiErrorDetail(res.status, body)
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, detail)
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
  blocked: { key: LimitKey; resets_at: string | null } | null
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
    const pair = await refresh(baseUrl, refreshToken)
    return { access_token: pair.access_token, refresh_token: pair.refresh_token }
  } catch {
    return null
  }
}
