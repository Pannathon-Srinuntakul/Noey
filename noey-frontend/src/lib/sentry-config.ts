/**
 * Error monitoring (Sentry) for this site: the pure half, unit-tested, no SDK
 * import. `src/instrumentation.ts` (server), `src/instrumentation-client.ts`
 * (browser) and `app/global-error.tsx` load the SDK — and only when a DSN is
 * configured. With NEXT_PUBLIC_SENTRY_DSN empty the SDK is never imported,
 * nothing is sent, and the CSP stays exactly as it was.
 *
 * Sources (fetched 2026-09-30):
 *  - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 *  - https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/
 *    (SDK v11: `dataCollection` replaces `sendDefaultPii`, and its defaults
 *    ALWAYS apply — they collect cookies, headers, bodies, query strings and
 *    user info. So every category is switched off here explicitly.)
 *  - https://docs.sentry.io/concepts/key-terms/dsn-explainer/ (a DSN is
 *    public: it can only submit events, so it may ship in the browser bundle)
 */

type Env = Record<string, string | undefined>;

/**
 * The public build-time variables, each referenced by its full literal name:
 * that is the only form Next.js inlines into the browser bundle (a spread or
 * a computed key of `process.env` is empty in the browser).
 */
export function publicSentryEnv(): Env {
  return {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    NODE_ENV: process.env.NODE_ENV,
  };
}

/** The same DSN serves the server and the browser. */
export function sentryDsn(env: Env = publicSentryEnv()): string | null {
  const dsn = env.NEXT_PUBLIC_SENTRY_DSN?.trim();
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

/** Options shared by the browser and the server `Sentry.init`. */
export function baseSentryOptions(env: Env = publicSentryEnv()) {
  return {
    dsn: sentryDsn(env) ?? undefined,
    environment: env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() || (env.NODE_ENV === "production" ? "production" : "development"),
    release: env.NEXT_PUBLIC_SENTRY_RELEASE?.trim() || undefined,
    tracesSampleRate: tracesSampleRate(env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
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
/** One-time values that ride in our URLs: emailed links (?token=) and the Google callback (?code=&state=). */
const SECRET_QUERY = /([?&](?:token|code|state|session_id|reauth_token|access_token|refresh_token)=)[^&#\s]*/gi;

export function scrubText(value: string): string {
  return value.replace(SECRET_QUERY, "$1[Filtered]").replace(JWT, "[Filtered]").replace(BEARER, "Bearer [Filtered]").replace(EMAIL, "[email]");
}

/** Drop the query string and fragment entirely: this site's URLs never need them for debugging. */
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
