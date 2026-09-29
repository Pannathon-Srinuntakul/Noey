/**
 * The two Google Route Handlers end to end, with the backend client faked:
 * start -> cookie + 303 to Google; callback -> state check, API call, session
 * cookies. No network, no Next.js server.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
const authedApi = vi.fn();

vi.mock("@/lib/server/api", () => ({ apiRequest: (...args: unknown[]) => apiRequest(...args) }));
vi.mock("@/lib/server/session", () => ({ authedApi: (...args: unknown[]) => authedApi(...args) }));

const { POST: start } = await import("@/app/api/auth/google/start/route");
const { GET: callback } = await import("@/app/auth/google/callback/route");

const SITE = "https://noeystudio.com";
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=S1";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`;
}

function startRequest(fields: Record<string, string>, origin: string | null = SITE): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", host: "noeystudio.com", "x-forwarded-proto": "https" };
  if (origin) headers.origin = origin;
  return new NextRequest(`${SITE}/api/auth/google/start`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

function callbackRequest(query: string, cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  return new NextRequest(`${SITE}/auth/google/callback?${query}`, { headers: { cookie } });
}

const ctx = (intent: string, next = "/account", from = "login") => JSON.stringify({ i: intent, n: next, f: from });

beforeEach(() => {
  apiRequest.mockReset();
  authedApi.mockReset();
});

describe("POST /api/auth/google/start", () => {
  it("refuses a cross-site POST", async () => {
    const response = await start(startRequest({ intent: "signin" }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("asks the backend with the registered redirect URI, keeps state in an HttpOnly Lax cookie, 303s to Google", async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { authorization_url: GOOGLE_URL, state: "S1", expires_in: 600 } });
    const response = await start(startRequest({ intent: "signin", from: "login", next: "/account/quota", "cf-turnstile-response": "tt" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(GOOGLE_URL);
    expect(apiRequest).toHaveBeenCalledWith("/auth/google/start", {
      method: "POST",
      body: { redirect_uri: `${SITE}/auth/google/callback`, intent: "signin", turnstile_token: "tt" },
    });
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/noey_g_state=S1;/);
    expect(setCookie).toMatch(/Path=\/auth\/google/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Max-Age=600/);
  });

  it("never follows a non-Google authorization URL", async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { authorization_url: "https://evil.example/", state: "S1" } });
    const response = await start(startRequest({ intent: "signin" }));
    expect(response.headers.get("location")).toBe("/login?google=error");
  });

  it("maps not_configured to a calm code (the variable name stays server-side)", async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 503, detail: null, data: { detail: { code: "not_configured", message: "… (GOOGLE_CLIENT_ID not set)" } } });
    const response = await start(startRequest({ intent: "signin", from: "login" }));
    expect(response.headers.get("location")).toBe("/login?google=not_configured");
  });

  it("requires the terms tick for a Google sign-up", async () => {
    const response = await start(startRequest({ intent: "signin", from: "signup", plan: "pro" }));
    expect(response.headers.get("location")).toBe("/signup?google=consent_required&plan=pro");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("runs link/reauth as the signed-in user", async () => {
    authedApi.mockResolvedValue({ kind: "ok", result: { ok: true, status: 200, data: { authorization_url: GOOGLE_URL, state: "S2" } } });
    const response = await start(startRequest({ intent: "reauth" }));
    expect(response.status).toBe(303);
    expect(authedApi.mock.calls[0][1].body.intent).toBe("reauth");
    expect(authedApi.mock.calls[0][1].body.turnstile_token).toBeUndefined();

    authedApi.mockResolvedValue({ kind: "unauthenticated" });
    const signedOut = await start(startRequest({ intent: "link" }));
    expect(signedOut.headers.get("location")).toBe("/login?next=%2Faccount%2Fprofile");
  });
});

describe("GET /auth/google/callback", () => {
  it("treats ?error= as a cancel and never calls the API", async () => {
    const response = await callback(callbackRequest("error=access_denied&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("signin") }));
    expect(response.headers.get("location")).toBe("/login?google=cancelled");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("refuses a state that does not match this browser's cookie (login CSRF)", async () => {
    const response = await callback(callbackRequest("code=C&state=ATTACKER", { noey_g_state: "S1", noey_g_ctx: ctx("signin") }));
    expect(response.headers.get("location")).toBe("/login?google=invalid_state");
    expect(apiRequest).not.toHaveBeenCalled();
    // Flow cookies are cleared either way.
    expect(response.headers.getSetCookie().join("\n")).toMatch(/noey_g_state=;.*Max-Age=0/);
  });

  it("refuses when the state cookie is missing", async () => {
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_ctx: ctx("signin") }));
    expect(response.headers.get("location")).toBe("/login?google=invalid_state");
  });

  it("signs in: same session cookies as a password login, no-referrer, code stripped from the URL", async () => {
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    const refresh = jwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    apiRequest.mockImplementation(async (path: string) =>
      path === "/auth/google/callback"
        ? { ok: true, status: 200, data: { access_token: access, refresh_token: refresh, intent: "signin", created: true } }
        : { ok: true, status: 200, data: { display_name: "น้อย" } },
    );
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("signin") }));
    expect(apiRequest).toHaveBeenCalledWith("/auth/google/callback", {
      method: "POST",
      body: { code: "C", state: "S1", redirect_uri: `${SITE}/auth/google/callback` },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/account?notice=google-welcome");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain(`noey_at=${access}`);
    expect(setCookie).toContain(`noey_rt=${refresh}`);
    expect(setCookie).toMatch(/noey_si=1/);
  });

  it("keeps a sanitised `next` and never an open redirect", async () => {
    const pair = { access_token: jwt({ exp: 9e9 }), refresh_token: jwt({ exp: 9e9 }) };
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { ...pair, intent: "signin", created: false } });
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("signin", "//evil.example") }));
    expect(response.headers.get("location")).toBe("/account");
  });

  it("sends a sign-in failure back with its code", async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 409, detail: null, data: { detail: { code: "link_requires_password", message: "…" } } });
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("signin") }));
    expect(response.headers.get("location")).toBe("/login?google=link_requires_password");
  });

  it("re-auth parks the proof in an HttpOnly cookie scoped to /account and returns to the delete step", async () => {
    authedApi.mockResolvedValue({ kind: "ok", result: { ok: true, status: 200, data: { intent: "reauth", reauth_token: "PROOF", expires_in: 300 } } });
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("reauth", "/account/profile") }));
    expect(response.headers.get("location")).toBe("/account/profile?delete=confirm#delete-account");
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/noey_reauth=PROOF;/);
    expect(setCookie).toMatch(/Path=\/account;/);
    expect(setCookie).toMatch(/Max-Age=300/);
  });

  it("link success lands on the profile page with a notice", async () => {
    authedApi.mockResolvedValue({ kind: "ok", result: { ok: true, status: 200, data: { intent: "link", google_email: "a@b.co" } } });
    const response = await callback(callbackRequest("code=C&state=S1", { noey_g_state: "S1", noey_g_ctx: ctx("link", "/account/profile") }));
    expect(response.headers.get("location")).toBe("/account/profile?google=linked#google");
  });
});
