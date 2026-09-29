/** deleteAccountAction / unlinkGoogleAction with the backend, cookies and redirect faked. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authedApi = vi.fn();
const clearSession = vi.fn();
const jar = new Map<string, string>();
const cookieSets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

class Redirect extends Error {
  constructor(public readonly path: string) {
    super(`redirect:${path}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirect(path);
  },
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieSets.push({ name, value, options });
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));
vi.mock("@/lib/server/session", () => ({
  authedApi: (...args: unknown[]) => authedApi(...args),
  clearSession: () => clearSession(),
  writeDisplayName: vi.fn(),
  writeSession: vi.fn(),
}));

const { deleteAccountAction, unlinkGoogleAction } = await import("@/app/actions/account");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const ok = (status: number, data: unknown = null) => ({ kind: "ok", result: { ok: status < 300, status, detail: null, data } });

beforeEach(() => {
  authedApi.mockReset();
  clearSession.mockReset();
  jar.clear();
  cookieSets.length = 0;
});

describe("deleteAccountAction", () => {
  it("demands the explicit 'I understand' tick before calling anything", async () => {
    const state = await deleteAccountAction(undefined, form({ method: "password", password: "pw" }));
    expect(state.fieldErrors?.understand).toBeTruthy();
    expect(authedApi).not.toHaveBeenCalled();
  });

  it("demands a password for a password account", async () => {
    const state = await deleteAccountAction(undefined, form({ method: "password", understand: "yes" }));
    expect(state.fieldErrors?.password).toBeTruthy();
    expect(authedApi).not.toHaveBeenCalled();
  });

  it("204: drops the session and lands on the goodbye page", async () => {
    authedApi.mockResolvedValue(ok(204));
    const error = await deleteAccountAction(undefined, form({ method: "password", password: "pw", understand: "yes" })).catch((e) => e);
    expect(error).toBeInstanceOf(Redirect);
    expect(error.path).toBe("/account-deleted");
    expect(clearSession).toHaveBeenCalledOnce();
    expect(authedApi.mock.calls[0][0]).toBe("/auth/delete-account");
    expect(authedApi.mock.calls[0][1].body).toEqual({ password: "pw", reauth_token: undefined, forfeit_wallet_balance: false });
  });

  it("409 wallet_balance asks for the forfeit, and the retry sends it", async () => {
    authedApi.mockResolvedValue(ok(409, { detail: { code: "wallet_balance", message: "…", balance_satang: 5000 } }));
    const state = await deleteAccountAction(undefined, form({ method: "password", password: "pw", understand: "yes" }));
    expect(state.walletBalanceSatang).toBe(5000);
    expect(clearSession).not.toHaveBeenCalled();

    authedApi.mockResolvedValue(ok(204));
    await deleteAccountAction(state, form({ method: "password", password: "pw", understand: "yes", forfeit_wallet_balance: "yes" })).catch(() => {});
    expect(authedApi.mock.calls[1][1].body.forfeit_wallet_balance).toBe(true);
  });

  it("wrong password is a field error; 503 billing_unavailable never shows the variable name", async () => {
    authedApi.mockResolvedValue(ok(400, { detail: { code: "wrong_password", message: "รหัสผ่านไม่ถูกต้อง" } }));
    expect((await deleteAccountAction(undefined, form({ method: "password", password: "x", understand: "yes" }))).fieldErrors?.password).toBe("รหัสผ่านไม่ถูกต้อง");

    authedApi.mockResolvedValue(ok(503, { detail: { code: "billing_unavailable", message: "… STRIPE_SECRET_KEY …" } }));
    const state = await deleteAccountAction(undefined, form({ method: "password", password: "x", understand: "yes" }));
    expect(state.error).not.toMatch(/STRIPE/);
  });

  it("Google-only: uses the parked proof, and restarts the Google step when it is gone or rejected", async () => {
    const missing = await deleteAccountAction(undefined, form({ method: "google", understand: "yes" }));
    expect(missing.reauthAgain).toBe(true);
    expect(authedApi).not.toHaveBeenCalled();

    jar.set("noey_reauth", "PROOF");
    authedApi.mockResolvedValue(ok(400, { detail: { code: "reauth_invalid", message: "…" } }));
    const rejected = await deleteAccountAction(undefined, form({ method: "google", understand: "yes" }));
    expect(authedApi.mock.calls[0][1].body).toEqual({ password: undefined, reauth_token: "PROOF", forfeit_wallet_balance: false });
    expect(rejected.reauthAgain).toBe(true);
    expect(jar.has("noey_reauth")).toBe(false);
  });

  it("unauthenticated goes to login", async () => {
    authedApi.mockResolvedValue({ kind: "unauthenticated" });
    const error = await deleteAccountAction(undefined, form({ method: "password", password: "pw", understand: "yes" })).catch((e) => e);
    expect(error.path).toBe("/login?next=%2Faccount%2Fprofile");
  });
});

describe("unlinkGoogleAction", () => {
  it("explains the 409 password_required", async () => {
    authedApi.mockResolvedValue(ok(409, { detail: { code: "password_required", message: "…" } }));
    const state = await unlinkGoogleAction();
    expect(state.error).toContain("ลืมรหัสผ่าน");
  });

  it("204 is a success", async () => {
    authedApi.mockResolvedValue(ok(204));
    expect((await unlinkGoogleAction()).ok).toBe(true);
    expect(authedApi).toHaveBeenCalledWith("/auth/google", { method: "DELETE" }, { mutable: true });
  });
});
