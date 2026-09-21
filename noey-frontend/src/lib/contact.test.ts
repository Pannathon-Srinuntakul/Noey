import { describe, expect, it } from "vitest";
import {
  CONTACT_LIMITS,
  HONEYPOT_FIELD,
  TURNSTILE_FIELD,
  fieldErrorsFromValidation,
  toBackendContact,
  validateContact,
} from "./contact";
import { isSameOriginRequest } from "./origin";

const good = { name: "นอย", email: "noey@example.com", message: "อยากถามเรื่องโหมดพากย์ใหม่ค่ะ" };

describe("validateContact (fast local feedback before the backend)", () => {
  it("accepts a normal message and trims it", () => {
    expect(validateContact({ ...good, name: "  นอย  " })).toEqual({ ok: true, value: good });
  });

  it("enforces length limits and a plausible email", () => {
    const result = validateContact({ name: "x".repeat(CONTACT_LIMITS.nameMax + 1), email: "not-an-email", message: "สั้น" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["email", "message", "name"]);
    expect(validateContact({ ...good, message: "ก".repeat(CONTACT_LIMITS.messageMax + 1) }).ok).toBe(false);
  });

  it("ignores non-string input instead of throwing", () => {
    expect(validateContact({ name: 1, email: {}, message: [] }).ok).toBe(false);
  });

  it("strips control characters but keeps line breaks in the message", () => {
    const result = validateContact({ ...good, message: "บรรทัดแรก\nบรรทัดสอง\u0007" });
    expect(result.ok && result.value.message).toBe("บรรทัดแรก\nบรรทัดสอง");
  });
});

describe("toBackendContact (POST {API_URL}/contact body)", () => {
  it("passes the honeypot through as `company` for the backend to judge", () => {
    const body = toBackendContact(good, { ...good, [HONEYPOT_FIELD]: "Spam Co" });
    expect(body).toEqual({ ...good, company: "Spam Co" });
  });

  it("sends an empty company for people and adds the Turnstile token when present", () => {
    expect(toBackendContact(good, { ...good, [TURNSTILE_FIELD]: "tok" })).toEqual({ ...good, company: "", turnstile_token: "tok" });
    expect(toBackendContact(good, good)).not.toHaveProperty("turnstile_token");
  });
});

describe("fieldErrorsFromValidation (FastAPI 422 -> Thai field errors)", () => {
  it("maps known fields to our own messages and never shows the backend's text", () => {
    const { fields, unmatched } = fieldErrorsFromValidation({
      detail: [
        { loc: ["body", "email"], msg: "value is not a valid email address", type: "value_error" },
        { loc: ["body", "message"], msg: "String should have at least 10 characters", type: "string_too_short" },
      ],
    });
    expect(Object.keys(fields).sort()).toEqual(["email", "message"]);
    expect(JSON.stringify(fields)).not.toMatch(/valid email|at least/);
    expect(unmatched).toBe(false);
  });

  it("flags anything it cannot place", () => {
    expect(fieldErrorsFromValidation({ detail: [{ loc: ["body", "turnstile_token"], msg: "x" }] }).unmatched).toBe(true);
    expect(fieldErrorsFromValidation({ detail: "bad" }).unmatched).toBe(true);
  });
});

describe("isSameOriginRequest", () => {
  const site = "https://noeystudio.com";
  const post = (headers: Record<string, string>) => new Request("http://localhost:3000/api/contact", { method: "POST", headers });

  it("accepts the site origin and the serving host", () => {
    expect(isSameOriginRequest(post({ origin: "https://noeystudio.com" }), site)).toBe(true);
    expect(isSameOriginRequest(post({ origin: "http://localhost:3000", host: "localhost:3000" }), site)).toBe(true);
  });

  it("rejects other sites, 'null' and a missing Origin", () => {
    expect(isSameOriginRequest(post({ origin: "https://evil.example", host: "localhost:3000" }), site)).toBe(false);
    expect(isSameOriginRequest(post({ origin: "null", host: "localhost:3000" }), site)).toBe(false);
    expect(isSameOriginRequest(post({ host: "localhost:3000" }), site)).toBe(false);
  });
});
