import type { NextRequest } from "next/server";
import { TURNSTILE_FIELD } from "@/lib/contact";
import {
  GOOGLE_CONTEXT_COOKIE,
  GOOGLE_COOKIE_PATH,
  GOOGLE_FLOW_MAX_AGE,
  GOOGLE_STATE_COOKIE,
  apiErrorInfo,
  callbackRedirectUri,
  encodeGoogleContext,
  googleOutcomeCode,
  googleReturnPath,
  isGoogleAuthorizationUrl,
  isGoogleIntent,
  type GoogleContext,
} from "@/lib/google-auth";
import { isSameOriginRequest } from "@/lib/origin";
import { isPaidTier } from "@/lib/plans";
import { apiRequest, type ApiResult } from "@/lib/server/api";
import { COOKIE_SECURE } from "@/lib/server/config";
import { redirectTo } from "@/lib/server/redirect";
import { authedApi } from "@/lib/server/session";
import { sanitizeNextPath } from "@/lib/session";
import { SITE_URL } from "@/lib/site";

interface StartOut {
  authorization_url?: unknown;
  state?: unknown;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * POST /api/auth/google/start — a plain form POST from the Google button
 * (sign-in / sign-up pages, and the profile page's link and re-auth buttons).
 *
 * Asks the backend for Google's authorization URL (it holds the PKCE verifier
 * and nonce; see backend packages/auth/google_oauth.py), keeps the returned
 * `state` in an HttpOnly cookie bound to this browser, and answers 303 so the
 * TOP window navigates to Google (never an iframe or popup).
 *
 * Every failure is a 303 back to the page the visitor came from with
 * `?google=<code>`; the page turns the code into fixed Thai text.
 */
export async function POST(request: NextRequest) {
  // Route Handlers get no built-in CSRF check (Server Actions do).
  if (!isSameOriginRequest(request, SITE_URL)) return new Response("Forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectTo(googleReturnPath(null, "error"), 303);
  }

  const intentField = field(form, "intent");
  const intent = isGoogleIntent(intentField) ? intentField : "signin";
  const from = field(form, "from") === "signup" ? "signup" : "login";
  const plan = field(form, "plan");
  let next = sanitizeNextPath(field(form, "next"));
  if (intent === "signin" && from === "signup") {
    next = isPaidTier(plan) ? `/account/billing?plan=${plan}&from=signup` : "/account";
  }
  if (intent !== "signin") next = "/account/profile";
  const context: GoogleContext = { intent, next, from };
  const back = (code: string) => redirectTo(googleReturnPath(context, code), 303);

  // Sign-UP needs the same explicit consent as the email form.
  if (intent === "signin" && from === "signup" && field(form, "agree") !== "yes") return back("consent_required");

  const body = {
    redirect_uri: callbackRedirectUri(SITE_URL),
    intent,
    turnstile_token: intent === "signin" ? field(form, TURNSTILE_FIELD) || undefined : undefined,
  };

  let result: ApiResult<StartOut>;
  if (intent === "signin") {
    result = await apiRequest<StartOut>("/auth/google/start", { method: "POST", body });
  } else {
    // link / reauth run as the signed-in user (refreshing the access token if needed).
    const outcome = await authedApi<StartOut>("/auth/google/start", { method: "POST", body }, { mutable: true });
    if (outcome.kind === "unauthenticated") return redirectTo("/login?next=%2Faccount%2Fprofile", 303);
    if (outcome.kind !== "ok") return back("error");
    result = outcome.result;
  }

  if (!result.ok) {
    if (result.status === 0) return back("error");
    if (result.status === 401) return intent === "signin" ? back("error") : redirectTo("/login?next=%2Faccount%2Fprofile", 303);
    const { code } = apiErrorInfo(result.data);
    return back(googleOutcomeCode(result.status, code));
  }

  const { authorization_url: authorizationUrl, state } = result.data ?? {};
  if (!isGoogleAuthorizationUrl(authorizationUrl) || typeof state !== "string" || state.length === 0 || state.length > 4096) {
    return back("error");
  }

  // Absolute on purpose: the one off-site redirect, checked just above.
  const response = redirectTo(authorizationUrl, 303);
  const cookie = { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax" as const, path: GOOGLE_COOKIE_PATH, maxAge: GOOGLE_FLOW_MAX_AGE };
  response.cookies.set(GOOGLE_STATE_COOKIE, state, cookie);
  response.cookies.set(GOOGLE_CONTEXT_COOKIE, encodeGoogleContext(context), cookie);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
