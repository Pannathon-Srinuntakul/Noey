import { NextResponse, type NextRequest } from "next/server";
import { isPaidTier } from "@/lib/plans";
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
 * Next.js 16 Proxy (formerly middleware). Runs only on the signed-in routes
 * and the two auth pages — marketing pages never pass through here and stay
 * fully static.
 *
 *  - /account/*, /checkout/*: no session cookie -> /login?next=<page>.
 *    An expired access token is refreshed HERE, before rendering, because a
 *    Server Component render cannot set cookies. The new cookies go on the
 *    response and are made visible to this same request's render.
 *  - /login, /signup: a signed-in visitor goes to /account (or `next`, or to
 *    the billing page with the plan they clicked).
 *
 * These are optimistic checks (cookie presence, unverified `exp`); every
 * backend call is still authorised by the backend itself.
 */

const API_URL = (process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");
const SECURE = process.env.NODE_ENV === "production";
const PATHNAME_HEADER = "x-noey-pathname";

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

  if (isTokenFresh(access)) return NextResponse.next({ request: { headers: forwarded } });
  if (!refresh) return redirectToLogin(request, returnTo, true);

  const refreshed = await refreshTokens(refresh, request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"));
  if (refreshed === "invalid") return redirectToLogin(request, returnTo, true);
  // Backend unreachable: keep the cookies and let the page show a calm error.
  if (refreshed === "unavailable") return NextResponse.next({ request: { headers: forwarded } });

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

  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const spec of specs) response.cookies.set(spec.name, spec.value, spec.options);
  return response;
}

export const config = {
  matcher: ["/account/:path*", "/checkout/:path*", "/login", "/signup"],
};
