import { describe, expect, it } from "vitest";
import { isSameOrigin, isSameSiteNavigation } from "./origin";

const h = (o: Record<string, string>) => new Headers(o);

describe("same-origin checks", () => {
  it("accepts this app and refuses others", () => {
    expect(isSameOrigin(h({ origin: "https://admin.x.th", host: "admin.x.th", "x-forwarded-proto": "https" }), undefined)).toBe(true);
    expect(isSameOrigin(h({ origin: "http://localhost:3001", host: "localhost:3001" }), undefined)).toBe(true);
    expect(isSameOrigin(h({ origin: "https://evil.example", host: "admin.x.th" }), "https://admin.x.th")).toBe(false);
    expect(isSameOrigin(h({ host: "admin.x.th" }), "https://admin.x.th")).toBe(false);
    expect(isSameOrigin(h({ origin: "null", host: "admin.x.th" }), "https://admin.x.th")).toBe(false);
  });

  it("allows only same-origin or typed navigations for downloads", () => {
    expect(isSameSiteNavigation(h({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameSiteNavigation(h({ "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameSiteNavigation(h({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameSiteNavigation(h({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
});
