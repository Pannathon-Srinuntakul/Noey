/**
 * Session primitives shared by Proxy, Server Actions and Route Handlers.
 * Pure (no Next.js imports) so they are unit-testable.
 *
 * Tokens live ONLY in HttpOnly cookies. Two extra cookies are deliberately
 * readable by JavaScript because they carry no credential:
 *   - SIGNED_IN_HINT ("1") lets the static header show the signed-in variant
 *     before first paint without making every marketing page dynamic;
 *   - DISPLAY_NAME is the user's own name for that header greeting.
 * Neither grants access to anything; the server always re-checks the tokens.
 */

export const ACCESS_COOKIE = "noey_at";
export const REFRESH_COOKIE = "noey_rt";
export const SIGNED_IN_HINT_COOKIE = "noey_si";
export const DISPLAY_NAME_COOKIE = "noey_name";

/** Refresh a little early so a token cannot expire between proxy and backend. */
export const ACCESS_REFRESH_SKEW_SECONDS = 60;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export function isTokenPair(value: unknown): value is TokenPair {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === "string" && v.access_token.length > 0 && typeof v.refresh_token === "string" && v.refresh_token.length > 0;
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Read a JWT payload WITHOUT verifying the signature. Only ever used to learn
 * when a token expires (an optimistic check); the backend verifies every
 * token it receives.
 */
export function decodeJwtPayload(token: string | undefined | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Expiry in epoch SECONDS, or null when the token has no readable `exp`. */
export function tokenExpiry(token: string | undefined | null): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/** True when the token exists and stays valid for at least `skewSeconds` more. */
export function isTokenFresh(
  token: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  skewSeconds: number = ACCESS_REFRESH_SKEW_SECONDS,
): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && exp - skewSeconds > nowSeconds;
}

/** Cookie lifetime that ends when the token does; never negative. */
export function maxAgeFor(token: string, fallbackSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  const exp = tokenExpiry(token);
  if (exp === null) return fallbackSeconds;
  return Math.max(0, exp - nowSeconds);
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
}

const ACCESS_FALLBACK_SECONDS = 30 * 60;
const REFRESH_FALLBACK_SECONDS = 14 * 24 * 60 * 60;
const NAME_MAX_LENGTH = 60;

/** Trim, drop control characters and cap length — the name ends up in CSS via the header script. */
export function sanitizeDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX_LENGTH);
}

/**
 * The header-greeting cookie; an empty name expires it. The value is the
 * plain name: Next.js URL-encodes cookie values when writing Set-Cookie and
 * decodes them when reading, so encoding here would double-encode.
 */
export function displayNameCookieSpec(displayName: string | null | undefined, maxAge: number, secure: boolean): CookieSpec {
  const name = sanitizeDisplayName(displayName);
  return {
    name: DISPLAY_NAME_COOKIE,
    value: name,
    options: { secure, sameSite: "lax", path: "/", httpOnly: false, maxAge: name ? maxAge : 0 },
  };
}

/** Lifetime of the session as a whole = the refresh token's remaining life. */
export function sessionMaxAge(refreshToken: string | undefined, nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return refreshToken ? maxAgeFor(refreshToken, REFRESH_FALLBACK_SECONDS, nowSeconds) : 0;
}

/**
 * The cookies written after login, signup and every refresh. `displayName`
 * undefined leaves the greeting cookie alone; null/"" clears it.
 */
export function sessionCookieSpecs(
  tokens: TokenPair,
  options: { secure: boolean; displayName?: string | null; nowSeconds?: number },
): CookieSpec[] {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const accessAge = maxAgeFor(tokens.access_token, ACCESS_FALLBACK_SECONDS, now);
  const refreshAge = maxAgeFor(tokens.refresh_token, REFRESH_FALLBACK_SECONDS, now);
  const base = { secure: options.secure, sameSite: "lax" as const, path: "/" as const };
  const specs: CookieSpec[] = [
    { name: ACCESS_COOKIE, value: tokens.access_token, options: { ...base, httpOnly: true, maxAge: accessAge } },
    { name: REFRESH_COOKIE, value: tokens.refresh_token, options: { ...base, httpOnly: true, maxAge: refreshAge } },
    { name: SIGNED_IN_HINT_COOKIE, value: "1", options: { ...base, httpOnly: false, maxAge: refreshAge } },
  ];
  if (options.displayName !== undefined) {
    specs.push(displayNameCookieSpec(options.displayName, refreshAge, options.secure));
  }
  return specs;
}

/**
 * The greeting cookie as found in `document.cookie` (still URL-encoded).
 * Server code reads it through Next.js, which has already decoded it — use
 * `sanitizeDisplayName` there instead.
 */
export function decodeDisplayNameCookie(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return sanitizeDisplayName(decodeURIComponent(raw));
  } catch {
    return "";
  }
}

export const SESSION_COOKIE_NAMES = [ACCESS_COOKIE, REFRESH_COOKIE, SIGNED_IN_HINT_COOKIE, DISPLAY_NAME_COOKIE] as const;

/**
 * Where to send a user after login. Only same-site relative paths are
 * accepted (no `//evil.com`, no `\\`, no scheme) and never back to an auth or
 * API route, so `?next=` can be neither an open redirect nor a loop.
 */
export function sanitizeNextPath(next: unknown, fallback = "/account"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next) || next.includes("\\")) return fallback;
  let url: URL;
  try {
    url = new URL(next, "https://placeholder.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://placeholder.invalid") return fallback;
  const path = url.pathname;
  if (path === "/login" || path === "/signup" || path.startsWith("/api/")) return fallback;
  return `${path}${url.search}${url.hash}`;
}

/** `/login?next=/account/billing` — used by Proxy and pages when a session is missing. */
export function loginPathFor(pathWithSearch: string): string {
  return `/login?next=${encodeURIComponent(sanitizeNextPath(pathWithSearch))}`;
}
