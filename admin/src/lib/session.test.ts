import { describe, expect, it } from "vitest";
import { cookieName, isFresh, safeNext, sessionSpecs, spec } from "./session";

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

describe("admin session cookies", () => {
  it("are __Host- prefixed, HttpOnly, Secure and SameSite=Strict in production", () => {
    const c = spec("access", "t", 60, true);
    expect(c.name).toBe("__Host-noey_admin_at");
    expect(c.options).toEqual({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 });
    expect(cookieName("device", false)).toBe("noey_admin_dev");
  });

  it("live as long as their tokens", () => {
    const now = 1_000_000;
    const specs = sessionSpecs(
      { access_token: jwt({ exp: now + 1800 }), refresh_token: jwt({ exp: now + 3600 }), access_expires_in: 1800, device_token: "d" },
      true,
      now,
    );
    expect(specs.map((s) => [s.name, s.options.maxAge])).toEqual([
      ["__Host-noey_admin_at", 1800],
      ["__Host-noey_admin_rt", 3600],
      ["__Host-noey_admin_dev", 14 * 24 * 3600],
    ]);
  });

  it("refreshes a minute early", () => {
    const now = 1_000_000;
    expect(isFresh(jwt({ exp: now + 61 }), now)).toBe(true);
    expect(isFresh(jwt({ exp: now + 59 }), now)).toBe(false);
    expect(isFresh("garbage", now)).toBe(false);
  });

  it("never redirects off-site", () => {
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil")).toBe("/");
    expect(safeNext("/?tab=users")).toBe("/?tab=users");
  });
});
