/**
 * Error monitoring (Sentry) for the admin dashboard: the pure half, unit-tested,
 * no SDK import. Mirrors noey-frontend/src/lib/sentry-config.ts (same privacy
 * settings, same scrubbing) with one deliberate difference: every value is read
 * at RUN time, server-side, like the rest of this app's settings (API_URL,
 * ADMIN_URL…) — the admin has no NEXT_PUBLIC_* build-time values, so the same
 * image can be pointed at a Sentry project, or none, with a restart.
 *
 *  - `src/instrumentation.ts` starts the server SDK;
 *  - `src/app/layout.tsx` renders `<Monitoring>`, which hands the browser the
 *    options below (a DSN is public: it can only submit events);
 *  - `src/proxy.ts` adds the DSN's ingest origin to `connect-src`.
 *
 * With SENTRY_DSN unset none of that happens: the SDK is never imported on
 * either side and the CSP is exactly what it was.
 *
 * Sources (fetched 2026-09-30):
 *  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 *  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/
 *    (SDK v11: `dataCollection` replaces `sendDefaultPii`, and its defaults
 *    ALWAYS apply — they collect cookies, headers, bodies, query strings and
 *    user info. So every category is switched off here explicitly.)
 *  - https://docs.sentry.io/concepts/key-terms/dsn-explainer/
 */

type Env = Record<string, string | undefined>;

/** The runtime variables, read on the server only. */
export function adminSentryEnv(): Env {
  return {
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
    RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    NODE_ENV: process.env.NODE_ENV,
  };
}

/** The same DSN serves the server and the browser. */
export function sentryDsn(env: Env = adminSentryEnv()): string | null {
  const dsn = env.SENTRY_DSN?.trim();
  return dsn ? dsn : null;
}

/**
 * The origin the browser SDK POSTs to (the host inside the DSN), for the
 * CSP `connect-src`. null when there is no DSN or it is not an https URL
 * (plain http is allowed only for a localhost relay during development).
 */
export function sentryIngestOrigin(dsn: string | null | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 0 (errors only, no tracing quota spent) unless the owner opts in; clamped to 0..1. */
export function tracesSampleRate(raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Every automatic data category off: no cookies, headers, bodies, query strings, user info or local variables. */
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} as const;

/**
 * The serialisable part of the options — what the server passes to the
 * browser as a prop (functions cannot cross that boundary). null = off.
 */
export interface MonitoringConfig {
  dsn: string;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
}

export function monitoringConfig(env: Env = adminSentryEnv()): MonitoringConfig | null {
  const dsn = sentryDsn(env);
  // A DSN the CSP could not allow would only produce blocked requests.
  if (!dsn || !sentryIngestOrigin(dsn)) return null;
  return {
    dsn,
    environment:
      env.SENTRY_ENVIRONMENT?.trim() ||
      env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
      (env.NODE_ENV === "production" ? "production" : "development"),
    release: env.SENTRY_RELEASE?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined,
    tracesSampleRate: tracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
  };
}

/** Options shared by the browser and the server `Sentry.init`. */
export function sentryOptions(config: MonitoringConfig) {
  return {
    ...config,
    dataCollection: PRIVATE_DATA_COLLECTION,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

// ── scrubbing (second line of defence behind dataCollection) ───────────────

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** One-time values that can ride in a URL. The admin itself only uses `?next=`, dropped with the query anyway. */
const SECRET_QUERY = /([?&](?:token|code|state|session_id|reauth_token|access_token|refresh_token)=)[^&#\s]*/gi;

export function scrubText(value: string): string {
  return value.replace(SECRET_QUERY, "$1[Filtered]").replace(JWT, "[Filtered]").replace(BEARER, "Bearer [Filtered]").replace(EMAIL, "[email]");
}

/** Drop the query string and fragment entirely: this app's URLs never need them for debugging. */
export function stripUrl(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

interface ScrubbableRequest {
  url?: string;
  query_string?: unknown;
  cookies?: unknown;
  headers?: unknown;
  data?: unknown;
  env?: unknown;
}

interface ScrubbableEvent {
  request?: ScrubbableRequest;
  user?: unknown;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
  transaction?: string;
}

interface ScrubbableBreadcrumb {
  message?: string;
  data?: { [key: string]: unknown };
}

export function scrubBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B {
  if (typeof breadcrumb.message === "string") breadcrumb.message = scrubText(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = stripUrl(data[key] as string);
    }
  }
  return breadcrumb;
}

export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.env;
    if (typeof event.request.url === "string") event.request.url = stripUrl(event.request.url);
  }
  delete event.user;
  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (typeof event.transaction === "string") event.transaction = stripUrl(event.transaction);
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") value.value = scrubText(value.value);
  }
  for (const breadcrumb of event.breadcrumbs ?? []) scrubBreadcrumb(breadcrumb);
  return event;
}
