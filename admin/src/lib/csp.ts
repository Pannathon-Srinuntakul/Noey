/**
 * The admin's Content-Security-Policy, built per request by src/proxy.ts with a
 * fresh nonce. Strict: only this origin's scripts carrying the nonce run (plus
 * what they load, via 'strict-dynamic') — no third-party script at all.
 *
 * `connect-src` gains exactly one origin, the Sentry ingest host inside the
 * run-time SENTRY_DSN, and only while that DSN is set (lib/sentry-config.ts).
 */
export function contentSecurityPolicy(opts: {
  nonce: string;
  /** Served over HTTPS (directly or behind a proxy that says so). */
  https: boolean;
  /** `next dev`: HMR needs eval and a websocket. */
  dev: boolean;
  sentryOrigin: string | null;
}): string {
  const { nonce, https, dev, sentryOrigin } = opts;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // React renders `style` attributes (bar widths, colours); attributes cannot
    // carry a nonce. No <style> element or stylesheet outside this origin runs.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${sentryOrigin ? ` ${sentryOrigin}` : ""}${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only behind HTTPS: on a plain-http local run it would rewrite every
    // asset URL to https:// and break the page.
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
