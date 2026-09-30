/**
 * Error monitoring for the web build — OFF unless VITE_SENTRY_DSN is set.
 *
 * With no DSN the SDK is never downloaded (dynamic import), never initialised
 * and nothing leaves the page. The DSN is public by design — it can submit
 * events, never read them — so a build-time variable is the right home for it
 * (https://docs.sentry.io/concepts/key-terms/dsn-explainer/). vite.config.ts
 * adds the DSN's ingest origin to the page's connect-src only when it is set.
 *
 * Privacy (the editor shows customers' footage, scripts and e-mail address):
 *   - SDK 11 removed `sendDefaultPii`; its replacement `dataCollection` is set
 *     to collect NOTHING optional — no user info, cookies, headers, bodies,
 *     query strings or stack-frame variables.
 *     https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
 *     https://docs.sentry.io/platforms/javascript/guides/react/data-management/data-collected/
 *   - No Session Replay and no tracing: errors only.
 *   - `scrubEvent` runs as beforeSend AND on every breadcrumb, and masks
 *     e-mail addresses, bearer tokens, JWTs, the query of every URL (the
 *     Google callback URL carries a one-time `code` for a moment) and the
 *     token in a `/transfer/<token>` path (the phone upload credential), and
 *     a `handoff=<code>` fragment (the site -> editor sign-in code; main.tsx
 *     strips it before monitoring starts, this is the second line).
 * Setup follows https://docs.sentry.io/platforms/javascript/guides/react/
 * (fetched 2026-09-30): `Sentry.init` before render, `reactErrorHandler` on
 * createRoot's error hooks.
 */

import type { RootOptions } from 'react-dom/client'

type Json = unknown

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi
const URL_QUERY_RE = /(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g
// The phone-transfer page's path IS its credential: `/transfer/<32 hex>` is a
// live single-use upload ticket until the desktop pulls the file.
const TRANSFER_RE = /\/transfer\/[A-Fa-f0-9]{32}\b/g
// The one-time sign-in code the account site hands over (lib/handoff.ts).
const HANDOFF_RE = /\bhandoff=[^\s&#"'<>]+/g

/** Mask secrets and personal data inside free text. */
export function scrubText(text: string): string {
  return text
    .replace(BEARER_RE, '$1 [Filtered]')
    .replace(JWT_RE, '[Filtered]')
    .replace(URL_QUERY_RE, '$1?[Filtered]')
    .replace(TRANSFER_RE, '/transfer/[Filtered]')
    .replace(HANDOFF_RE, 'handoff=[Filtered]')
    .replace(EMAIL_RE, '[email]')
}

/** A URL with its query and fragment removed; path kept for grouping. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/)
  return scrubText(cut === -1 ? url : url.slice(0, cut))
}

// Substring match for obvious secret names; exact match for short words that
// would otherwise swallow harmless keys (`status_code`, `state_label`).
const SECRET_KEY_RE = /pass|secret|token|cookie|authorization|session|dsn|otp|signature|csrf/i
const SECRET_EXACT = new Set(['code', 'state', 'nonce', 'email', 'auth', 'jwt', 'key'])

function isSecretKey(k: string): boolean {
  return SECRET_KEY_RE.test(k) || SECRET_EXACT.has(k.toLowerCase())
}

function scrubValue(value: Json, depth = 0): Json {
  if (depth > 6) return '[Filtered]'
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (k === 'url' && typeof v === 'string') out[k] = scrubUrl(v)
      else out[k] = isSecretKey(k) ? '[Filtered]' : scrubValue(v, depth + 1)
    }
    return out
  }
  return value
}

interface ScrubbableEvent {
  message?: string
  transaction?: string
  request?: {
    url?: string
    headers?: unknown
    cookies?: unknown
    data?: unknown
    query_string?: unknown
  }
  user?: unknown
  exception?: { values?: { value?: string }[] }
  breadcrumbs?: ScrubbableBreadcrumb[]
  extra?: Record<string, Json>
  contexts?: Record<string, Json>
  tags?: Record<string, Json>
}

interface ScrubbableBreadcrumb {
  message?: string
  data?: Record<string, Json>
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  if (typeof crumb.message === 'string') crumb.message = scrubText(crumb.message)
  if (crumb.data) crumb.data = scrubValue(crumb.data) as Record<string, Json>
  return crumb
}

/** beforeSend: drop what identifies a person, mask what could be a secret. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.user
  if (event.request) {
    delete event.request.headers
    delete event.request.cookies
    delete event.request.data
    delete event.request.query_string
    if (typeof event.request.url === 'string') event.request.url = scrubUrl(event.request.url)
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message)
  if (typeof event.transaction === 'string') event.transaction = scrubText(event.transaction)
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = scrubText(ex.value)
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b))
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, Json>
  if (event.contexts) event.contexts = scrubValue(event.contexts) as Record<string, Json>
  if (event.tags) event.tags = scrubValue(event.tags) as Record<string, Json>
  return event
}

export interface MonitoringConfig {
  dsn: string
  environment: string
  release: string
}

/** The build-time config, or null when monitoring is off. */
export function monitoringConfig(env: {
  dsn?: string
  environment?: string
  release?: string
}): MonitoringConfig | null {
  const dsn = (env.dsn ?? '').trim()
  if (!dsn) return null
  try {
    const u = new URL(dsn)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  } catch {
    return null
  }
  return {
    dsn,
    environment: (env.environment ?? '').trim() || 'production',
    release: (env.release ?? '').trim()
  }
}

/**
 * Initialise the SDK when a DSN was baked in. Returns createRoot options that
 * report React's own error hooks, or `{}` when monitoring is off. Never
 * throws: a monitoring failure must not stop the editor from booting.
 */
export async function initMonitoring(): Promise<RootOptions> {
  const cfg = monitoringConfig({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT,
    release: import.meta.env.VITE_SENTRY_RELEASE
  })
  if (!cfg) return {}
  try {
    const Sentry = await import('@sentry/react')
    Sentry.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      ...(cfg.release ? { release: cfg.release } : {}),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        genAI: { inputs: false, outputs: false }
      },
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb)
    })
    return {
      onUncaughtError: Sentry.reactErrorHandler(),
      onCaughtError: Sentry.reactErrorHandler(),
      onRecoverableError: Sentry.reactErrorHandler()
    }
  } catch {
    return {}
  }
}
