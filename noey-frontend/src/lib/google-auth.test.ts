import { describe, expect, it } from "vitest";
import {
  apiErrorInfo,
  callbackRedirectUri,
  decodeGoogleContext,
  deleteAccountMessage,
  encodeGoogleContext,
  formatBahtFromSatang,
  googleMessage,
  googleOutcomeCode,
  googleReturnPath,
  isGoogleAuthorizationUrl,
  statesMatch,
} from "./google-auth";

describe("Google flow helpers", () => {
  it("builds the one registered redirect URI from the site origin", () => {
    expect(callbackRedirectUri("https://noeystudio.com")).toBe("https://noeystudio.com/auth/google/callback");
    expect(callbackRedirectUri("http://localhost:3000/")).toBe("http://localhost:3000/auth/google/callback");
  });

  it("round-trips the flow context and rejects junk", () => {
    const raw = encodeGoogleContext({ intent: "signin", next: "/account/billing", from: "signup" });
    expect(decodeGoogleContext(raw)).toEqual({ intent: "signin", next: "/account/billing", from: "signup" });
    expect(decodeGoogleContext("not json")).toBeNull();
    expect(decodeGoogleContext(JSON.stringify({ i: "admin" }))).toBeNull();
    expect(decodeGoogleContext(undefined)).toBeNull();
    expect(decodeGoogleContext("x".repeat(2000))).toBeNull();
  });

  it("compares state exactly", () => {
    expect(statesMatch("abc.def", "abc.def")).toBe(true);
    expect(statesMatch("abc.def", "abc.deg")).toBe(false);
    expect(statesMatch("abc", "abc.def")).toBe(false);
    expect(statesMatch("", "")).toBe(false);
    expect(statesMatch("abc", undefined)).toBe(false);
    expect(statesMatch(null, "abc")).toBe(false);
  });

  it("only ever redirects to Google's own HTTPS OAuth host", () => {
    expect(isGoogleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
    expect(isGoogleAuthorizationUrl("http://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
    expect(isGoogleAuthorizationUrl("https://accounts.google.com.evil.example/o/oauth2")).toBe(false);
    expect(isGoogleAuthorizationUrl("https://user:pw@accounts.google.com/")).toBe(false);
    expect(isGoogleAuthorizationUrl("https://evil.example/?u=https://accounts.google.com")).toBe(false);
    expect(isGoogleAuthorizationUrl("javascript:alert(1)")).toBe(false);
    expect(isGoogleAuthorizationUrl(42)).toBe(false);
  });

  it("reads {code, message, balance_satang} error bodies defensively", () => {
    expect(apiErrorInfo({ detail: { code: "wallet_balance", message: "…", balance_satang: 12345 } })).toEqual({ code: "wallet_balance", balanceSatang: 12345 });
    expect(apiErrorInfo({ detail: "plain string" })).toEqual({ code: null, balanceSatang: null });
    expect(apiErrorInfo({ detail: { code: "<script>" } }).code).toBeNull();
    expect(apiErrorInfo(null)).toEqual({ code: null, balanceSatang: null });
  });

  it("maps backend codes to fixed Thai text, never echoing the backend's message", () => {
    expect(googleOutcomeCode(409, "link_requires_password")).toBe("link_requires_password");
    expect(googleOutcomeCode(503, "not_configured")).toBe("not_configured");
    expect(googleOutcomeCode(503, null)).toBe("store_unavailable");
    expect(googleOutcomeCode(429, "anything")).toBe("rate_limited");
    expect(googleOutcomeCode(500, "brand_new_code")).toBe("error");
    // A success code can never be forged from an API failure.
    expect(googleOutcomeCode(400, "linked")).toBe("error");
    expect(googleMessage("cancelled")?.text).toBe("ยกเลิกการเข้าสู่ระบบด้วย Google แล้ว");
    expect(googleMessage("linked")?.ok).toBe(true);
    expect(googleMessage("toString")).toBeNull();
    expect(googleMessage("__proto__")).toBeNull();
    // not_configured must not name a server variable.
    expect(googleMessage("not_configured")?.text).not.toMatch(/GOOGLE_|[A-Z]{4,}_/);
  });

  it("returns a failed flow to the page it started from", () => {
    expect(googleReturnPath(null, "cancelled")).toBe("/login?google=cancelled");
    expect(googleReturnPath({ intent: "signin", from: "login", next: "/account/quota" }, "invalid_state")).toBe(
      "/login?google=invalid_state&next=%2Faccount%2Fquota",
    );
    expect(googleReturnPath({ intent: "signin", from: "signup", next: "/account/billing?plan=pro&from=signup" }, "captcha_required")).toBe(
      "/signup?google=captcha_required&plan=pro",
    );
    expect(googleReturnPath({ intent: "link", from: "login", next: "/account/profile" }, "google_in_use")).toBe(
      "/account/profile?google=google_in_use#google",
    );
    expect(googleReturnPath({ intent: "reauth", from: "login", next: "/account/profile" }, "not_linked_google")).toBe(
      "/account/profile?google=not_linked_google&delete=retry#delete-account",
    );
  });
});

describe("account deletion messages", () => {
  it("never shows the backend text that names a server variable", () => {
    const text = deleteAccountMessage(503, "billing_unavailable");
    expect(text).not.toMatch(/STRIPE|SECRET|KEY/);
    expect(text).toContain("บัญชียังไม่ถูกลบ");
  });

  it("covers every documented code", () => {
    for (const code of ["wrong_password", "reauth_required", "reauth_invalid", "admin_account", "wallet_balance", "billing_cancel_failed", "deletion_incomplete"]) {
      expect(deleteAccountMessage(400, code)).not.toBe(deleteAccountMessage(500, null));
    }
    expect(deleteAccountMessage(429, null)).toBe("ส่งถี่เกินไป ลองใหม่อีกครั้งภายหลัง");
  });

  it("formats a satang balance as baht", () => {
    expect(formatBahtFromSatang(123450)).toBe("1,234.50");
  });
});
