import { createHash } from "node:crypto";
import { PREPAINT_SCRIPT } from "./prepaint";

/**
 * Content-Security-Policy, in two flavours. Pure (no Next.js import) so
 * next.config.ts, src/proxy.ts and the unit tests share one definition.
 *
 *  - STATIC (`staticContentSecurityPolicy`, set by next.config.ts): the
 *    marketing pages and /login, /signup are prerendered, so no per-request
 *    nonce exists; `'unsafe-inline'` is needed for the theme pre-paint script
 *    and Next's inline flight scripts. Every script ORIGIN is still pinned.
 *  - NONCE (`nonceContentSecurityPolicy`, set by src/proxy.ts on /account/*
 *    and /checkout/*): those pages render per request, so Next.js stamps its
 *    own scripts with the nonce it parses from the request's CSP header and
 *    no inline script without it runs. The pre-paint script in the root
 *    layout carries no nonce (reading one there would make every marketing
 *    page dynamic), so it is allowed by its hash instead. `'strict-dynamic'`
 *    lets the nonce'd runtime load next/script (Turnstile); the host entry
 *    remains for browsers without CSP3.
 *
 * Turnstile is the only third-party script. `form-action` lists every host a
 * form submit here is REDIRECTED to, because browsers apply `form-action` to
 * the redirect target of a form POST as well as to the form's own URL:
 * Stripe's hosted pages (a no-JavaScript plan-button submit is answered with a
 * 303 to Checkout / the Customer Portal — if the backend ever uses a Stripe
 * custom domain, add it here) and accounts.google.com (the "sign in with
 * Google" button POSTs to /api/auth/google/start, which answers with a 303 to
 * Google's consent screen; without it Chrome blocks the submit outright).
 *
 * `connect-src` gains exactly one origin — the Sentry ingest host inside
 * NEXT_PUBLIC_SENTRY_DSN — and only when that DSN is set. The Google sign-in
 * flow needs nothing in `connect-src`: accounts.google.com is reached by a
 * top-level navigation, not a fetch, frame or script.
 */

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Cloudflare Web Analytics (cookie-free page counts, no consent banner needed).
 * Cloudflare injects the beacon itself on the proxied www host; the script
 * loads from static.cloudflareinsights.com and reports to cloudflareinsights.com.
 * Allowed on the STATIC (public) policy only: the signed-in /account and
 * /checkout pages keep it blocked, and the Cloudflare rule counts www only.
 */
const ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
const ANALYTICS_REPORT_ORIGIN = "https://cloudflareinsights.com";

/** `'sha256-…'` source for the constant pre-paint script in app/layout.tsx. */
export const PREPAINT_SCRIPT_HASH = `'sha256-${createHash("sha256").update(PREPAINT_SCRIPT, "utf8").digest("base64")}'`;

function policy(scriptSrc: string, sentryOrigin: string | null, extraConnect: readonly string[] = []): string {
  const connect = ["'self'", ...(sentryOrigin ? [sentryOrigin] : []), ...extraConnect].join(" ");
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function staticContentSecurityPolicy(sentryOrigin: string | null): string {
  return policy(
    `script-src 'self' 'unsafe-inline' ${TURNSTILE_ORIGIN} ${ANALYTICS_SCRIPT_ORIGIN}`,
    sentryOrigin,
    [ANALYTICS_REPORT_ORIGIN],
  );
}

export function nonceContentSecurityPolicy(nonce: string, sentryOrigin: string | null): string {
  return policy(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${PREPAINT_SCRIPT_HASH} ${TURNSTILE_ORIGIN}`, sentryOrigin);
}

/** A fresh, unguessable nonce per request (128 bits, base64). */
export function newCspNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/**
 * Pages that get the per-request nonce policy (Proxy) instead of the static
 * one (next.config.ts). Keep in step with STATIC_CSP_SOURCE below and the
 * Proxy matcher.
 */
export function usesNonceCsp(pathname: string): boolean {
  return /^\/(?:account|checkout)(?:\/|$)/.test(pathname);
}

/**
 * next.config.ts `headers()` source for the static policy: every path EXCEPT
 * /account, /account/*, /checkout, /checkout/* (a response must not carry
 * both policies — browsers enforce each one). `/account-deleted` is a static
 * page and keeps the static policy.
 */
export const STATIC_CSP_SOURCE = "/:path((?!account(?:/|$)|checkout(?:/|$)).*)";
