import { NextResponse, type NextRequest } from "next/server";
import { blogProxy } from "@/lib/blog-proxy";
import { newCspNonce, nonceContentSecurityPolicy, usesNonceCsp } from "@/lib/csp";
import { isPaidTier } from "@/lib/plans";
import { sentryDsn, sentryIngestOrigin } from "@/lib/sentry-config";
import {
  ACCESS_COOKIE,
  DISPLAY_NAME_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE_NAMES,
  isTokenFresh,
  isTokenPair,
  loginPathFor,
  sanitizeDisplayName,
  sanitizeNextPath,
  sessionCookieSpecs,
  type TokenPair,
} from "@/lib/session";

/**
 * Next.js 16 Proxy (formerly middleware). Runs only on the signed-in routes,
 * the two auth pages and the blog — the other marketing pages never pass
 * through here. (Passing through does not make a page dynamic: the blog's
 * pages stay ISR; Proxy only turns a missing post into the real 404.)
 *
 *  - /account/*, /checkout/*: no session cookie -> /login?next=<page>.
 *    An expired access token is refreshed HERE, before rendering, because a
 *    Server Component render cannot set cookies. The new cookies go on the
 *    response and are made visible to this same request's render.
 *  - /login, /signup: a signed-in visitor goes to /account (or `next`, or to
 *    the billing page with the plan they clicked).
 *  - /account/*, /checkout/* also get a per-request nonce CSP (production
 *    only, like the static one in next.config.ts): Next.js reads the nonce
 *    from the forwarded request header and stamps its scripts with it.
 *
 * These are optimistic checks (cookie presence, unverified `exp`); every
 * backend call is still authorised by the backend itself.
 */

const API_URL = (process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");
const SECURE = process.env.NODE_ENV === "production";
const PATHNAME_HEADER = "x-noey-pathname";
const CSP_ENABLED = process.env.NODE_ENV === "production";
const SENTRY_ORIGIN = sentryIngestOrigin(sentryDsn());

type Refreshed = TokenPair | "invalid" | "unavailable";

async function refreshTokens(refreshToken: string, forwardedFor: string | null): Promise<Refreshed> {
  try {
    // Forward the visitor's address chain so backend per-IP limits see the visitor, not this server.
    const headers: Record<string, string> = { Authorization: `Bearer ${refreshToken}`, Accept: "application/json" };
    if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) return "invalid";
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json();
    return isTokenPair(body) ? body : "unavailable";
  } catch {
    return "unavailable";
  }
}

function redirectToLogin(request: NextRequest, returnTo: string, clear: boolean): NextResponse {
  const response = NextResponse.redirect(new URL(loginPathFor(returnTo), request.url));
  if (clear) for (const name of SESSION_COOKIE_NAMES) response.cookies.delete(name);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  // The blog: a missing post or page gets the site's real 404 (lib/blog-proxy.ts).
  if (pathname === "/blog" || pathname.startsWith("/blog/")) return blogProxy(request, API_URL);
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const hasSession = !!(access || refresh);

  if (pathname === "/login" || pathname === "/signup") {
    if (!hasSession) return NextResponse.next();
    const plan = searchParams.get("plan");
    const destination =
      pathname === "/signup"
        ? isPaidTier(plan)
          ? `/account/billing?plan=${plan}`
          : "/account"
        : sanitizeNextPath(searchParams.get("next"));
    return NextResponse.redirect(new URL(destination, request.url));
  }

  const returnTo = `${pathname}${search}`;
  if (!hasSession) return redirectToLogin(request, returnTo, false);

  const forwarded = new Headers(request.headers);
  forwarded.set(PATHNAME_HEADER, returnTo);
  const policy = CSP_ENABLED && usesNonceCsp(pathname) ? nonceContentSecurityPolicy(newCspNonce(), SENTRY_ORIGIN) : null;
  // Next.js parses the nonce out of the REQUEST header while rendering.
  if (policy) forwarded.set("Content-Security-Policy", policy);
  const render = (): NextResponse => {
    const response = NextResponse.next({ request: { headers: forwarded } });
    if (policy) response.headers.set("Content-Security-Policy", policy);
    return response;
  };

  if (isTokenFresh(access)) return render();
  if (!refresh) return redirectToLogin(request, returnTo, true);

  const refreshed = await refreshTokens(refresh, request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"));
  if (refreshed === "invalid") return redirectToLogin(request, returnTo, true);
  // Backend unreachable: keep the cookies and let the page show a calm error.
  if (refreshed === "unavailable") return render();

  const specs = sessionCookieSpecs(refreshed, {
    secure: SECURE,
    displayName: sanitizeDisplayName(request.cookies.get(DISPLAY_NAME_COOKIE)?.value),
  });

  // The render below must already see the new tokens.
  const jar = new Map(request.cookies.getAll().map((cookie) => [cookie.name, cookie.value]));
  for (const spec of specs) {
    if (spec.options.maxAge > 0) jar.set(spec.name, spec.value);
    else jar.delete(spec.name);
  }
  // Values from request.cookies are decoded; re-encode for the header (a Thai
  // display name is not valid raw header text).
  forwarded.set(
    "cookie",
    [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
  );

  const response = render();
  for (const spec of specs) response.cookies.set(spec.name, spec.value, spec.options);
  return response;
}

export const config = {
  matcher: ["/account/:path*", "/checkout/:path*", "/login", "/signup", "/blog", "/blog/:path*"],
};
