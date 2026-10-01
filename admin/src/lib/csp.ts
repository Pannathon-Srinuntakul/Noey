/**
 * The admin's Content-Security-Policy, built per request by src/proxy.ts with a
 * fresh nonce. Strict: only this origin's scripts carrying the nonce run (plus
 * what they load, via 'strict-dynamic') — no third-party script at all.
 *
 * `connect-src` gains exactly one origin, the Sentry ingest host inside the
 * run-time SENTRY_DSN, and only while that DSN is set (lib/sentry-config.ts).
 * `img-src` gains exactly one origin, the blog image store's (the article
 * preview shows cover and inline images), and only while it is configured.
 */
export function contentSecurityPolicy(opts: {
  nonce: string;
  /** Served over HTTPS (directly or behind a proxy that says so). */
  https: boolean;
  /** `next dev`: HMR needs eval and a websocket. */
  dev: boolean;
  sentryOrigin: string | null;
  /** Origin of the blog image store (BLOG_MEDIA_PUBLIC_URL), or null. */
  mediaOrigin?: string | null;
}): string {
  const { nonce, https, dev, sentryOrigin, mediaOrigin } = opts;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // React renders `style` attributes (bar widths, colours); attributes cannot
    // carry a nonce. No <style> element or stylesheet outside this origin runs.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob:${mediaOrigin ? ` ${mediaOrigin}` : ""}`,
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

/** The origin of a configured URL (http/https only), else null. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}
