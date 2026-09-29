import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

function req(headers: Record<string, string>) {
  return new NextRequest("http://localhost:3001/signout", { headers });
}

describe("GET /signout", () => {
  it("clears the session cookies on a same-origin navigation", () => {
    const res = GET(req({ "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3001/login");
    expect(res.headers.getSetCookie()).toHaveLength(3);
  });

  it("clears them on a typed URL and when Sec-Fetch-Site is absent", () => {
    expect(GET(req({ "sec-fetch-site": "none" })).headers.getSetCookie()).toHaveLength(3);
    expect(GET(req({})).headers.getSetCookie()).toHaveLength(3);
  });

  it("does not clear anything on a cross-site navigation (logout CSRF)", () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = GET(req({ "sec-fetch-site": site }));
      expect(res.headers.get("location")).toBe("http://localhost:3001/login");
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
