import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/csp";
import { sentryDsn, sentryIngestOrigin } from "@/lib/sentry-config";
import { cookieName, isAdminTokens, isFresh, sessionSpecs, type AdminTokens } from "@/lib/session";

/**
 * Next.js 16 Proxy (formerly middleware), on every page request:
 *
 *  1. A fresh CSP nonce per request (strict CSP: only this origin's scripts
 *     carrying the nonce run — no third-party script at all). `connect-src`
 *     gains exactly one origin — the Sentry ingest host inside SENTRY_DSN —
 *     and only while that run-time DSN is set (lib/sentry-config.ts).
 *  2. Signed-out visitors go to /login; an expiring access token is refreshed
 *     here, because a Server Component render cannot write cookies.
 *
 * This is the optimistic layer only. Every page, action and route handler
 * still asks the backend, which re-checks the admin session on each call.
 */

const API_URL = (process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");
const SECURE = process.env.NODE_ENV === "production";
const DEV = process.env.NODE_ENV === "development";
/** Read once per process: SENTRY_DSN is a run-time setting, fixed for the process's life. */
const SENTRY_ORIGIN = sentryIngestOrigin(sentryDsn());

type Refreshed = AdminTokens | "invalid" | "unavailable";

async function refresh(token: string, request: NextRequest): Promise<Refreshed> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    const xff = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
    if (xff) headers["X-Forwarded-For"] = xff;
    const ua = request.headers.get("user-agent");
    if (ua) headers["User-Agent"] = ua.slice(0, 255);
    const r = await fetch(`${API_URL}/admin/auth/refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 401 || r.status === 403) return "invalid";
    if (!r.ok) return "unavailable";
    const body: unknown = await r.json();
    return isAdminTokens(body) ? body : "unavailable";
  } catch {
    return "unavailable";
  }
}

function withSecurityHeaders(response: NextResponse, policy: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const policy = contentSecurityPolicy({ nonce, https, dev: DEV, sentryOrigin: SENTRY_ORIGIN });
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set("Content-Security-Policy", policy);

  const { pathname, search } = request.nextUrl;
  const accessName = cookieName("access", SECURE);
  const refreshName = cookieName("refresh", SECURE);
  const access = request.cookies.get(accessName)?.value;
  const refreshToken = request.cookies.get(refreshName)?.value;

  const toLogin = (clear: boolean) => {
    const target = new URL("/login", request.url);
    if (pathname !== "/") target.searchParams.set("next", `${pathname}${search}`);
    const response = withSecurityHeaders(NextResponse.redirect(target), policy);
    if (clear) {
      for (const name of [accessName, refreshName]) {
        response.cookies.set(name, "", { httpOnly: true, secure: SECURE, sameSite: "strict", path: "/", maxAge: 0 });
      }
    }
    return response;
  };

  if (pathname === "/login") {
    if (access && isFresh(access)) return withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)), policy);
    return withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), policy);
  }

  if (access && isFresh(access)) return withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), policy);
  if (!refreshToken) return toLogin(!!access);

  const refreshed = await refresh(refreshToken, request);
  if (refreshed === "invalid") return toLogin(true);
  if (refreshed === "unavailable") return withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), policy);

  const specs = sessionSpecs(refreshed, SECURE);
  const jar = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
  for (const s of specs) jar.set(s.name, s.value);
  forwarded.set("cookie", [...jar].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; "));
  const response = withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), policy);
  for (const s of specs) response.cookies.set(s.name, s.value, s.options);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
