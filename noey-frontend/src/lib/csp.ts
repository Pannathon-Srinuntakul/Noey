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
 * Turnstile is the only third-party script. `form-action` lists Stripe's
 * hosted pages because a no-JavaScript plan-button submit is answered with a
 * 303 redirect to Checkout / the Customer Portal — if the backend ever uses a
 * Stripe custom domain, add it here.
 *
 * `connect-src` gains exactly one origin — the Sentry ingest host inside
 * NEXT_PUBLIC_SENTRY_DSN — and only when that DSN is set. The Google sign-in
 * flow needs nothing here: accounts.google.com is a top-level navigation (a
 * 303 from our own server), not a fetch, frame or script.
 */

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** `'sha256-…'` source for the constant pre-paint script in app/layout.tsx. */
export const PREPAINT_SCRIPT_HASH = `'sha256-${createHash("sha256").update(PREPAINT_SCRIPT, "utf8").digest("base64")}'`;

function policy(scriptSrc: string, sentryOrigin: string | null): string {
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    sentryOrigin ? `connect-src 'self' ${sentryOrigin}` : "connect-src 'self'",
    `frame-src ${TURNSTILE_ORIGIN}`,
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function staticContentSecurityPolicy(sentryOrigin: string | null): string {
  return policy(`script-src 'self' 'unsafe-inline' ${TURNSTILE_ORIGIN}`, sentryOrigin);
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
