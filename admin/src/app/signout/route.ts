import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SECURE } from "@/lib/server/config";
import { cookieName, type CookieKind } from "@/lib/session";

/**
 * GET /signout — where a page render goes when the backend refused the
 * session (a render cannot clear cookies; without this, /login's "already
 * signed in" check and the page would redirect to each other forever).
 * Only clears this browser's session cookies; the remembered device stays.
 */
export function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  for (const kind of ["access", "refresh", "challenge"] as CookieKind[]) {
    response.cookies.set(cookieName(kind, COOKIE_SECURE), "", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: "/", maxAge: 0 });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
