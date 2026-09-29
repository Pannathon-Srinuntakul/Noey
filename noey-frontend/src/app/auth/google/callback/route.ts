import type { NextRequest } from "next/server";
import {
  GOOGLE_CONTEXT_COOKIE,
  GOOGLE_COOKIE_PATH,
  GOOGLE_STATE_COOKIE,
  REAUTH_COOKIE,
  REAUTH_COOKIE_PATH,
  REAUTH_MAX_AGE_CAP,
  apiErrorInfo,
  callbackRedirectUri,
  decodeGoogleContext,
  googleOutcomeCode,
  googleReturnPath,
  statesMatch,
  type GoogleContext,
} from "@/lib/google-auth";
import { apiRequest, type ApiResult, type MeOut } from "@/lib/server/api";
import { COOKIE_SECURE } from "@/lib/server/config";
import { redirectTo } from "@/lib/server/redirect";
import { authedApi } from "@/lib/server/session";
import { isTokenPair, sanitizeDisplayName, sanitizeNextPath, sessionCookieSpecs } from "@/lib/session";
import { SITE_URL } from "@/lib/site";

// Never cached: every hit carries a one-time code.
export const dynamic = "force-dynamic";

type CallbackOut = {
  intent?: unknown;
  created?: unknown;
  reauth_token?: unknown;
  expires_in?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
};

/**
 * GET /auth/google/callback?code=…&state=… — where Google sends the browser
 * back (registered verbatim in Google Cloud Console and in the backend's
 * GOOGLE_REDIRECT_URIS as `${NEXT_PUBLIC_SITE_URL}/auth/google/callback`).
 *
 *  1. `?error=` (the visitor pressed cancel, or Google refused): no API call.
 *  2. The returned `state` must equal the HttpOnly cookie set by
 *     /api/auth/google/start, exactly (login-CSRF: a code minted for someone
 *     else's browser is refused here). Both flow cookies are deleted either way.
 *  3. POST /auth/google/callback. For link / re-auth the signed-in user's
 *     access token goes along; the backend checks it is the same user.
 *  4. Sign-in: the returned pair becomes the session cookies exactly as a
 *     password login writes them. Re-auth: the 5-minute proof is parked in an
 *     HttpOnly cookie scoped to /account for the final "delete" click.
 *
 * The response always redirects (so `code`/`state` leave the address bar) and
 * carries `Referrer-Policy: no-referrer` (so they never leak in a Referer).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const context: GoogleContext | null = decodeGoogleContext(request.cookies.get(GOOGLE_CONTEXT_COOKIE)?.value);
  const keptState = request.cookies.get(GOOGLE_STATE_COOKIE)?.value;

  const finish = (path: string) => {
    const response = redirectTo(path, 303);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(GOOGLE_STATE_COOKIE, "", { path: GOOGLE_COOKIE_PATH, maxAge: 0, httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax" });
    response.cookies.set(GOOGLE_CONTEXT_COOKIE, "", { path: GOOGLE_COOKIE_PATH, maxAge: 0, httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax" });
    return response;
  };
  const back = (code: string) => finish(googleReturnPath(context, code));

  if (params.get("error")) return back("cancelled");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || code.length > 4096 || !context || !statesMatch(state, keptState)) return back("invalid_state");

  const body = { code, state, redirect_uri: callbackRedirectUri(SITE_URL) };
  let result: ApiResult<CallbackOut>;
  if (context.intent === "signin") {
    result = await apiRequest<CallbackOut>("/auth/google/callback", { method: "POST", body });
  } else {
    const outcome = await authedApi<CallbackOut>("/auth/google/callback", { method: "POST", body }, { mutable: true });
    if (outcome.kind === "unauthenticated") return back("signed_out");
    if (outcome.kind !== "ok") return back("error");
    result = outcome.result;
  }

  if (!result.ok) {
    if (result.status === 0) return back("error");
    if (result.status === 401 && context.intent !== "signin") return back("signed_out");
    return back(googleOutcomeCode(result.status, apiErrorInfo(result.data).code));
  }

  const data = result.data ?? {};
  if (context.intent === "signin") {
    const pair = { access_token: data.access_token, refresh_token: data.refresh_token };
    if (!isTokenPair(pair)) return back("error");
    // Greet by the account's own name, as password login does.
    const me = await apiRequest<MeOut>("/auth/me", { token: pair.access_token });
    const displayName = me.ok ? sanitizeDisplayName(me.data?.display_name ?? null) : null;
    const next = sanitizeNextPath(context.next);
    const destination = data.created === true && next === "/account" ? "/account?notice=google-welcome" : next;
    const response = finish(destination);
    for (const spec of sessionCookieSpecs(pair, { secure: COOKIE_SECURE, displayName })) {
      response.cookies.set(spec.name, spec.value, spec.options);
    }
    return response;
  }

  if (context.intent === "link") return finish("/account/profile?google=linked#google");

  // reauth
  const proof = data.reauth_token;
  if (typeof proof !== "string" || proof.length === 0 || proof.length > 4096) return back("error");
  const lifetime = typeof data.expires_in === "number" && data.expires_in > 0 ? Math.min(data.expires_in, REAUTH_MAX_AGE_CAP) : REAUTH_MAX_AGE_CAP;
  const response = finish("/account/profile?delete=confirm#delete-account");
  response.cookies.set(REAUTH_COOKIE, proof, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    // Lax, not Strict: this response ends a redirect chain that started on
    // accounts.google.com, and the profile page it lands on must see it.
    sameSite: "lax",
    path: REAUTH_COOKIE_PATH,
    maxAge: Math.floor(lifetime),
  });
  return response;
}

