import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { callWithRefresh, type AuthedOutcome, type RefreshOutcome } from "../auth-flow";
import {
  ACCESS_COOKIE,
  DISPLAY_NAME_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE_NAMES,
  displayNameCookieSpec,
  isTokenPair,
  loginPathFor,
  sanitizeDisplayName,
  sanitizeNextPath,
  sessionCookieSpecs,
  sessionMaxAge,
  type TokenPair,
} from "../session";
import { apiRequest, type ApiRequestInit, type ApiResult, type MeOut } from "./api";
import { COOKIE_SECURE } from "./config";

/** Request header Proxy sets so layouts can build `?next=` for the current page. */
export const PATHNAME_HEADER = "x-noey-pathname";

export async function readSessionTokens(): Promise<{ access?: string; refresh?: string }> {
  const store = await cookies();
  return {
    access: store.get(ACCESS_COOKIE)?.value || undefined,
    refresh: store.get(REFRESH_COOKIE)?.value || undefined,
  };
}

/**
 * Server Actions / Route Handlers only — Server Component renders cannot set
 * cookies. `displayName` undefined keeps the current greeting cookie (its
 * lifetime is extended to match the new refresh token).
 */
export async function writeSession(tokens: TokenPair, displayName?: string | null): Promise<void> {
  const store = await cookies();
  const name = displayName === undefined ? sanitizeDisplayName(store.get(DISPLAY_NAME_COOKIE)?.value) : displayName;
  for (const spec of sessionCookieSpecs(tokens, { secure: COOKIE_SECURE, displayName: name })) {
    store.set(spec.name, spec.value, spec.options);
  }
}

/** Update only the header greeting after a profile change. */
export async function writeDisplayName(displayName: string | null): Promise<void> {
  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  const spec = displayNameCookieSpec(displayName, sessionMaxAge(refresh), COOKIE_SECURE);
  store.set(spec.name, spec.value, spec.options);
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) store.delete(name);
}

/** `POST /auth/refresh` — the refresh token goes in the Authorization header (see backend auth.py). */
export async function refreshWithBackend(refreshToken: string): Promise<RefreshOutcome> {
  const result = await apiRequest<TokenPair>("/auth/refresh", { method: "POST", token: refreshToken, timeoutMs: 8_000 });
  if (result.ok && isTokenPair(result.data)) return { kind: "ok", tokens: result.data };
  if (result.status === 401 || result.status === 403) return { kind: "invalid" };
  return { kind: "unavailable" };
}

/**
 * Call the backend as the signed-in user, refreshing tokens transparently.
 * `mutable` must be true only in Server Actions and Route Handlers.
 */
export async function authedApi<T>(
  path: string,
  init: Omit<ApiRequestInit, "token">,
  options: { mutable: boolean },
): Promise<AuthedOutcome<ApiResult<T>>> {
  const tokens = await readSessionTokens();
  return callWithRefresh<ApiResult<T>>({
    access: tokens.access,
    refresh: tokens.refresh,
    canPersist: options.mutable,
    call: (token) => apiRequest<T>(path, { ...init, token }),
    refreshTokens: refreshWithBackend,
    persist: (pair) => writeSession(pair),
    clear: clearSession,
  });
}

/** Path of the page being rendered, as forwarded by Proxy. */
export async function currentPathname(fallback: string): Promise<string> {
  const value = (await headers()).get(PATHNAME_HEADER);
  return sanitizeNextPath(value, fallback);
}

/**
 * For Server Component renders under /account and /checkout: resolve the
 * outcome or leave the page — to /login when the session is gone, or through
 * the refresh route when only a cookie write stands between us and a fresh
 * token. Returns null when the backend is unreachable so the page can say so.
 */
export function resolvePageOutcome<T>(outcome: AuthedOutcome<T>, returnTo: string): T | null {
  switch (outcome.kind) {
    case "ok":
      return outcome.result;
    case "unauthenticated":
      redirect(loginPathFor(returnTo));
    case "needs-refresh":
      redirect(`/api/auth/refresh?next=${encodeURIComponent(sanitizeNextPath(returnTo))}`);
    case "unavailable":
      return null;
  }
}

/** `GET /auth/me` once per request (React cache), shared by the account layout and pages. */
export const getMe = cache(async (): Promise<AuthedOutcome<ApiResult<MeOut>>> => {
  return authedApi<MeOut>("/auth/me", {}, { mutable: false });
});
