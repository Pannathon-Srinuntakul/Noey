/**
 * CSRF guard for Route Handler POSTs. Browsers attach `Origin` to every POST
 * (fetch and form); a request from another site carries that site's origin
 * and cannot forge ours. A missing Origin is rejected too.
 *
 * Server Actions do not need this — Next.js compares Origin with Host for
 * them itself.
 */
export function isSameOriginRequest(request: Request, siteUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  const allowed = new Set<string>();
  try {
    allowed.add(new URL(siteUrl).origin);
  } catch {
    // ignore a malformed SITE_URL; the request host below still applies
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const proto = forwardedProto ?? new URL(request.url).protocol.replace(":", "");
    allowed.add(`${proto}://${host}`);
  }
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}
