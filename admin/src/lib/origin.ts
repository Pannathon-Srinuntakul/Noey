/**
 * CSRF guard (same approach as noey-frontend/src/lib/origin.ts). A browser
 * attaches `Origin` to every POST; a request from another site carries that
 * site's origin and cannot forge ours. A missing or "null" Origin is refused.
 * Server Actions already get Next.js's own Origin/Host check — this runs as
 * well, explicitly, in every mutating action and route handler.
 */
export function isSameOrigin(headers: Headers, appUrl: string | undefined): boolean {
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  const allowed = new Set<string>();
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      // ignore a malformed ADMIN_URL; the Host below still applies
    }
  }
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host) {
    const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    allowed.add(`${proto}://${host}`);
  }
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/** For GET downloads (CSV): only a navigation from this site, or a typed URL. */
export function isSameSiteNavigation(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
