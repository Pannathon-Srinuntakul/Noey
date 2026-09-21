import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  DISPLAY_NAME_COOKIE,
  REFRESH_COOKIE,
  SIGNED_IN_HINT_COOKIE,
  decodeJwtPayload,
  isTokenFresh,
  loginPathFor,
  sanitizeDisplayName,
  sanitizeNextPath,
  sessionCookieSpecs,
  tokenExpiry,
} from "./session";

/** Unsigned test JWT — only the payload matters to these helpers. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const NOW = 1_800_000_000;

describe("JWT expiry (optimistic, unverified)", () => {
  it("reads exp from the payload", () => {
    expect(tokenExpiry(jwt({ sub: "1", exp: NOW + 1800 }))).toBe(NOW + 1800);
    expect(decodeJwtPayload(jwt({ type: "access" }))?.type).toBe("access");
  });

  it("returns null for garbage", () => {
    expect(tokenExpiry("not-a-jwt")).toBeNull();
    expect(tokenExpiry("a.b.c")).toBeNull();
    expect(tokenExpiry(undefined)).toBeNull();
  });

  it("considers a token fresh only with time to spare", () => {
    expect(isTokenFresh(jwt({ exp: NOW + 1800 }), NOW)).toBe(true);
    expect(isTokenFresh(jwt({ exp: NOW + 30 }), NOW, 60)).toBe(false);
    expect(isTokenFresh(jwt({ exp: NOW - 1 }), NOW)).toBe(false);
    expect(isTokenFresh(undefined, NOW)).toBe(false);
  });
});

describe("sessionCookieSpecs", () => {
  const tokens = {
    access_token: jwt({ exp: NOW + 1800, type: "access" }),
    refresh_token: jwt({ exp: NOW + 14 * 86400, type: "refresh" }),
  };

  it("keeps both tokens HttpOnly + SameSite=Lax and ties lifetimes to token expiry", () => {
    const specs = sessionCookieSpecs(tokens, { secure: true, nowSeconds: NOW });
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName[ACCESS_COOKIE].options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
    expect(byName[REFRESH_COOKIE].options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", maxAge: 14 * 86400 });
    expect(byName[ACCESS_COOKIE].value).toBe(tokens.access_token);
  });

  it("exposes only a boolean hint (never a token) to client JavaScript", () => {
    const specs = sessionCookieSpecs(tokens, { secure: false, nowSeconds: NOW, displayName: "นอย" });
    const readable = specs.filter((s) => !s.options.httpOnly);
    expect(readable.map((s) => s.name).sort()).toEqual([DISPLAY_NAME_COOKIE, SIGNED_IN_HINT_COOKIE].sort());
    for (const spec of readable) {
      expect(spec.value).not.toContain(tokens.access_token);
      expect(spec.value).not.toContain(tokens.refresh_token);
    }
    expect(specs.find((s) => s.name === SIGNED_IN_HINT_COOKIE)?.value).toBe("1");
    // Plain value: Next.js encodes cookie values itself when writing Set-Cookie.
    expect(specs.find((s) => s.name === DISPLAY_NAME_COOKIE)!.value).toBe("นอย");
  });

  it("is Secure only when asked (production)", () => {
    for (const spec of sessionCookieSpecs(tokens, { secure: false, nowSeconds: NOW })) {
      expect(spec.options.secure).toBe(false);
    }
  });

  it("expires the name cookie when the name is empty", () => {
    const spec = sessionCookieSpecs(tokens, { secure: true, nowSeconds: NOW, displayName: null }).find(
      (s) => s.name === DISPLAY_NAME_COOKIE,
    );
    expect(spec?.options.maxAge).toBe(0);
  });
});

describe("sanitizeDisplayName", () => {
  it("strips control characters and caps length", () => {
    expect(sanitizeDisplayName("  นอย\n\u0000 ")).toBe("นอย");
    expect(sanitizeDisplayName("ก".repeat(200))).toHaveLength(60);
    expect(sanitizeDisplayName(null)).toBe("");
  });
});

describe("sanitizeNextPath (open-redirect guard)", () => {
  it("keeps same-site relative paths", () => {
    expect(sanitizeNextPath("/account/billing?plan=pro")).toBe("/account/billing?plan=pro");
    expect(sanitizeNextPath("/pricing#faq")).toBe("/pricing#faq");
  });

  it("rejects external, protocol-relative and scheme URLs", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil", ""]) {
      expect(sanitizeNextPath(bad)).toBe("/account");
    }
  });

  it("never loops back to auth pages or the API", () => {
    expect(sanitizeNextPath("/login?next=/login")).toBe("/account");
    expect(sanitizeNextPath("/signup")).toBe("/account");
    expect(sanitizeNextPath("/api/auth/refresh")).toBe("/account");
  });

  it("builds the login redirect used by Proxy", () => {
    expect(loginPathFor("/account/billing?plan=pro")).toBe("/login?next=%2Faccount%2Fbilling%3Fplan%3Dpro");
    expect(loginPathFor("//evil.example")).toBe("/login?next=%2Faccount");
  });
});
