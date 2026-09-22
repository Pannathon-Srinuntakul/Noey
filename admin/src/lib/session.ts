/**
 * Admin session cookies. Pure (no Next.js imports) so proxy.ts, Server
 * Actions, Route Handlers and tests share one definition.
 *
 * Every cookie is HttpOnly and SameSite=Strict; in production they are Secure
 * and carry the `__Host-` prefix (host-only, path=/, no Domain — a sibling
 * subdomain cannot set or read them). The browser never sees a token.
 */

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export interface CookieSpec {
  name: string;
  value: string;
  options: CookieOptions;
}

export type CookieKind = "access" | "refresh" | "device" | "challenge";

const BASE: Record<CookieKind, string> = {
  access: "noey_admin_at",
  refresh: "noey_admin_rt",
  device: "noey_admin_dev",
  challenge: "noey_admin_ch",
};

export function cookieName(kind: CookieKind, secure: boolean): string {
  return secure ? `__Host-${BASE[kind]}` : BASE[kind];
}

export const DEVICE_MAX_AGE = 14 * 24 * 60 * 60;
export const CHALLENGE_MAX_AGE = 10 * 60;
/** Refresh a little early so a token cannot expire between here and the backend. */
export const ACCESS_SKEW_SECONDS = 60;

export function spec(kind: CookieKind, value: string, maxAge: number, secure: boolean): CookieSpec {
  return {
    name: cookieName(kind, secure),
    value,
    options: { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: Math.max(0, Math.floor(maxAge)) },
  };
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** `exp` of a JWT WITHOUT verifying it — only to decide when to refresh. The backend verifies. */
export function tokenExpiry(token: string | undefined | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(base64UrlDecode(parts[1]))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

export function isFresh(token: string | undefined | null, now = Math.floor(Date.now() / 1000)): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && exp - ACCESS_SKEW_SECONDS > now;
}

export interface AdminTokens {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
  device_token?: string | null;
}

export function isAdminTokens(value: unknown): value is AdminTokens {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === "string" && v.access_token.length > 0 && typeof v.refresh_token === "string" && v.refresh_token.length > 0;
}

/** Cookies for a signed-in admin: access + refresh (+ remembered device). */
export function sessionSpecs(tokens: AdminTokens, secure: boolean, now = Math.floor(Date.now() / 1000)): CookieSpec[] {
  const accessExp = tokenExpiry(tokens.access_token) ?? now + tokens.access_expires_in;
  const refreshExp = tokenExpiry(tokens.refresh_token) ?? now + 12 * 3600;
  const out = [spec("access", tokens.access_token, accessExp - now, secure), spec("refresh", tokens.refresh_token, refreshExp - now, secure)];
  if (tokens.device_token) out.push(spec("device", tokens.device_token, DEVICE_MAX_AGE, secure));
  return out;
}

/** Only same-site, relative paths — never an open redirect. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
