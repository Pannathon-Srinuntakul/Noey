import { NextResponse, type NextRequest } from "next/server";
import { apiRequest } from "@/lib/server/api";
import { COOKIE_SECURE } from "@/lib/server/config";
import { redirectTo } from "@/lib/server/redirect";
import { refreshWithBackend } from "@/lib/server/session";
import {
  DISPLAY_NAME_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE_NAMES,
  loginPathFor,
  sanitizeDisplayName,
  sanitizeNextPath,
  sessionCookieSpecs,
} from "@/lib/session";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * GET /api/auth/refresh?next=/account/billing
 *
 * A Server Component render cannot write cookies, so when one finds the access
 * token rejected it sends the browser here: refresh, set cookies, go back.
 * The new token is checked against /auth/me before redirecting so a token
 * the backend keeps rejecting cannot cause a redirect loop. When the backend
 * is down, answer with a page instead of redirecting (also loop-proof).
 */
export async function GET(request: NextRequest) {
  const next = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  const toLogin = () => {
    const response = redirectTo(loginPathFor(next));
    for (const name of SESSION_COOKIE_NAMES) response.cookies.delete(name);
    return response;
  };

  if (!refreshToken) return toLogin();

  const outcome = await refreshWithBackend(refreshToken);
  if (outcome.kind === "invalid") return toLogin();
  if (outcome.kind === "unavailable") {
    return new NextResponse(
      `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="robots" content="noindex"><title>ระบบขัดข้องชั่วคราว | Noey Studio</title><body style="font-family:system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 20px;line-height:1.7"><h1 style="font-weight:400">ระบบขัดข้องชั่วคราว</h1><p>เชื่อมต่อระบบบัญชีไม่ได้ในตอนนี้ ลองใหม่อีกครั้งในอีกสักครู่</p><p><a href="${escapeHtml(next)}">ลองอีกครั้ง</a> · <a href="/">กลับหน้าแรก</a></p></body></html>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" } },
    );
  }

  const me = await apiRequest("/auth/me", { token: outcome.tokens.access_token });
  if (!me.ok) return me.status === 0 ? redirectTo("/") : toLogin();

  const response = redirectTo(next);
  const displayName = sanitizeDisplayName(request.cookies.get(DISPLAY_NAME_COOKIE)?.value);
  for (const spec of sessionCookieSpecs(outcome.tokens, { secure: COOKIE_SECURE, displayName })) {
    response.cookies.set(spec.name, spec.value, spec.options);
  }
  return response;
}
