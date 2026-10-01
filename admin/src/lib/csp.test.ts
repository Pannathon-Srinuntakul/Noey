import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, originOf } from "./csp";
import { sentryIngestOrigin } from "./sentry-config";

const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `));

describe("admin CSP", () => {
  it("connects to this origin only while monitoring is off", () => {
    const policy = contentSecurityPolicy({ nonce: "n1", https: true, dev: false, sentryOrigin: null });
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'nonce-n1' 'strict-dynamic'");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("adds exactly the DSN's ingest origin when a DSN is set, and nothing to script-src", () => {
    const origin = sentryIngestOrigin("https://pub@o4501.ingest.us.sentry.io/4502");
    const policy = contentSecurityPolicy({ nonce: "n2", https: false, dev: false, sentryOrigin: origin });
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' https://o4501.ingest.us.sentry.io");
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'nonce-n2' 'strict-dynamic'");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("allows images from the blog media origin only when configured", () => {
    const off = contentSecurityPolicy({ nonce: "n", https: true, dev: false, sentryOrigin: null });
    expect(directive(off, "img-src")).toBe("img-src 'self' data: blob:");
    const on = contentSecurityPolicy({
      nonce: "n", https: true, dev: false, sentryOrigin: null, mediaOrigin: originOf("https://media.noeystudio.com/blog/x"),
    });
    expect(directive(on, "img-src")).toBe("img-src 'self' data: blob: https://media.noeystudio.com");
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  it("keeps the dev-only allowances out of production", () => {
    const dev = contentSecurityPolicy({ nonce: "n", https: false, dev: true, sentryOrigin: null });
    expect(dev).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toBe("connect-src 'self' ws:");
  });
});
