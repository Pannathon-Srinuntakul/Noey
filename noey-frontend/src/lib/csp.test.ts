import { createHash } from "node:crypto";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREPAINT_SCRIPT_HASH,
  STATIC_CSP_SOURCE,
  newCspNonce,
  nonceContentSecurityPolicy,
  staticContentSecurityPolicy,
  usesNonceCsp,
} from "./csp";
import { PREPAINT_SCRIPT } from "./prepaint";

function scriptSrc(policy: string): string {
  return policy.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
}

describe("nonce CSP for the signed-in pages", () => {
  it("allows no inline script except by nonce or the pre-paint hash", () => {
    const src = scriptSrc(nonceContentSecurityPolicy("abc123==", null));
    expect(src).not.toContain("'unsafe-inline'");
    expect(src).not.toContain("'unsafe-eval'");
    expect(src).toContain("'nonce-abc123=='");
    expect(src).toContain("'strict-dynamic'");
    expect(src).toContain(PREPAINT_SCRIPT_HASH);
  });

  it("hashes the exact pre-paint script the root layout renders", () => {
    const expected = createHash("sha256").update(PREPAINT_SCRIPT).digest("base64");
    expect(PREPAINT_SCRIPT_HASH).toBe(`'sha256-${expected}'`);
  });

  it("keeps every other directive identical to the static policy", () => {
    const strip = (p: string) => p.split("; ").filter((d) => !d.startsWith("script-src ")).join("; ");
    const origin = "https://o1.ingest.sentry.io";
    expect(strip(nonceContentSecurityPolicy("n", origin))).toBe(strip(staticContentSecurityPolicy(origin)));
  });

  it("makes a fresh nonce each call", () => {
    const a = newCspNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newCspNonce()).not.toBe(a);
  });

  it("covers /account and /checkout but not look-alike static pages", () => {
    for (const p of ["/account", "/account/", "/account/billing", "/checkout", "/checkout/success"]) {
      expect(usesNonceCsp(p)).toBe(true);
    }
    for (const p of ["/", "/account-deleted", "/accounting", "/login", "/signup", "/pricing"]) {
      expect(usesNonceCsp(p)).toBe(false);
    }
  });

  it("the static header source skips exactly the nonce pages", () => {
    const match = getPathMatch(STATIC_CSP_SOURCE, { strict: true, removeUnnamedParams: true, regexModifier: undefined });
    for (const p of ["/", "/pricing", "/login", "/signup", "/account-deleted", "/api/auth/refresh", "/guide/help"]) {
      expect(match(p), p).not.toBe(false);
      expect(usesNonceCsp(p)).toBe(false);
    }
    for (const p of ["/account", "/account/billing", "/checkout/success"]) {
      expect(match(p), p).toBe(false);
      expect(usesNonceCsp(p)).toBe(true);
    }
  });
});

describe("Proxy sets the nonce CSP (production)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadProxy() {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    return (await import("@/proxy")).proxy;
  }

  function freshAccessToken(): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  }

  it("on /account: response and forwarded request carry the same fresh nonce policy", async () => {
    const proxy = await loadProxy();
    const request = new NextRequest("https://noeystudio.com/account/billing", {
      headers: { cookie: `noey_at=${freshAccessToken()}` },
    });
    const first = await proxy(request);
    const policy = first.headers.get("content-security-policy") ?? "";
    expect(scriptSrc(policy)).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc(policy)).not.toContain("'unsafe-inline'");
    // Next.js reads the nonce from the forwarded REQUEST header.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    const second = await proxy(
      new NextRequest("https://noeystudio.com/account", { headers: { cookie: `noey_at=${freshAccessToken()}` } }),
    );
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
  });

  it("leaves the statically rendered /login alone", async () => {
    const proxy = await loadProxy();
    const response = await proxy(new NextRequest("https://noeystudio.com/login"));
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("form-action covers every host a form submit is redirected to", () => {
  // Browsers apply form-action to the redirect target of a form POST too: the
  // Google button POSTs to /api/auth/google/start, answered by a 303 to Google.
  for (const [name, csp] of [
    ["static", staticContentSecurityPolicy(null)],
    ["nonce", nonceContentSecurityPolicy("abc", null)],
  ] as const) {
    it(`${name} policy allows Google's consent screen and Stripe`, () => {
      const formAction = csp.split("; ").find((d) => d.startsWith("form-action "));
      expect(formAction).toContain("https://accounts.google.com");
      expect(formAction).toContain("https://checkout.stripe.com");
      expect(formAction).toContain("https://billing.stripe.com");
    });
  }
});
