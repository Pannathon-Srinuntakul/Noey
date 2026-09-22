import "server-only";
import { cookies } from "next/headers";
import { cookieName, isAdminTokens, isFresh, sessionSpecs, type CookieKind } from "../session";
import { adminApi } from "./api";
import { COOKIE_SECURE } from "./config";

/**
 * Session plumbing for Server Actions and Route Handlers (which may write
 * cookies). Pages render with whatever proxy.ts already refreshed; every
 * backend call is still authorised by the backend against its session row.
 */

export async function readCookie(kind: CookieKind): Promise<string | undefined> {
  return (await cookies()).get(cookieName(kind, COOKIE_SECURE))?.value;
}

export async function writeTokens(tokens: unknown): Promise<void> {
  if (!isAdminTokens(tokens)) return;
  const jar = await cookies();
  for (const s of sessionSpecs(tokens, COOKIE_SECURE)) jar.set(s.name, s.value, s.options);
}

/** Expire one cookie with the same attributes it was set with (a `__Host-`
 * cookie is only replaced by a Secure, path=/ Set-Cookie). */
export async function deleteCookie(kind: CookieKind): Promise<void> {
  (await cookies()).set(cookieName(kind, COOKIE_SECURE), "", {
    httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: "/", maxAge: 0,
  });
}

export async function clearSession(options: { forgetDevice?: boolean } = {}): Promise<void> {
  const kinds: CookieKind[] = ["access", "refresh", "challenge"];
  if (options.forgetDevice) kinds.push("device");
  for (const kind of kinds) await deleteCookie(kind);
}

/**
 * A usable access token, refreshing it (and rewriting the cookies) when it is
 * about to expire. null = no live session; the caller answers "sign in again".
 */
export async function accessToken(): Promise<string | null> {
  const access = await readCookie("access");
  if (access && isFresh(access)) return access;
  const refresh = await readCookie("refresh");
  if (!refresh) return null;
  const r = await adminApi<unknown>("/admin/auth/refresh", { method: "POST", body: { refresh_token: refresh } });
  if (!r.ok || !isAdminTokens(r.data)) {
    if (r.status === 401) await clearSession();
    return null;
  }
  await writeTokens(r.data);
  return r.data.access_token;
}
