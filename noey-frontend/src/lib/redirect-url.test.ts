import { describe, expect, it } from "vitest";
import { isSafeExternalRedirect } from "./redirect-url";

describe("isSafeExternalRedirect", () => {
  it("accepts https Stripe-hosted pages", () => {
    expect(isSafeExternalRedirect("https://checkout.stripe.com/c/pay/cs_test_123", true)).toBe(true);
    expect(isSafeExternalRedirect("https://billing.stripe.com/p/session/test_123", true)).toBe(true);
  });

  it("rejects script, data, credentials and non-strings", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "https://user:pass@evil.example", "", 42, null]) {
      expect(isSafeExternalRedirect(bad, true)).toBe(false);
    }
  });

  it("allows http://localhost only outside production", () => {
    expect(isSafeExternalRedirect("http://localhost:8787/mock-checkout", false)).toBe(true);
    expect(isSafeExternalRedirect("http://localhost:8787/mock-checkout", true)).toBe(false);
    expect(isSafeExternalRedirect("http://evil.example", false)).toBe(false);
  });
});
