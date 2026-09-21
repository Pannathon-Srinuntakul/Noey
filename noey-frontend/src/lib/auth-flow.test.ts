import { describe, expect, it, vi } from "vitest";
import { callWithRefresh, type RefreshOutcome } from "./auth-flow";

function jwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ exp })}.sig`;
}

const NOW = 1_800_000_000;
const fresh = jwt(NOW + 1800);
const stale = jwt(NOW - 10);
const newPair = { access_token: jwt(NOW + 1800) + "new", refresh_token: jwt(NOW + 86400) };

/** A mocked backend: 401 for any token in `rejected`, 200 otherwise. */
function backend(rejected: string[] = []) {
  return vi.fn(async (token: string) => ({ status: rejected.includes(token) ? 401 : 200, token }));
}

function harness(overrides: {
  access?: string;
  refresh?: string;
  canPersist?: boolean;
  rejected?: string[];
  refreshOutcome?: RefreshOutcome;
}) {
  const call = backend(overrides.rejected);
  const refreshTokens = vi.fn(async (): Promise<RefreshOutcome> => overrides.refreshOutcome ?? { kind: "ok", tokens: newPair });
  const persist = vi.fn();
  const clear = vi.fn();
  const run = () =>
    callWithRefresh({
      access: overrides.access,
      refresh: overrides.refresh,
      canPersist: overrides.canPersist ?? true,
      call,
      refreshTokens,
      persist,
      clear,
      nowSeconds: NOW,
    });
  return { call, refreshTokens, persist, clear, run };
}

describe("callWithRefresh", () => {
  it("uses a fresh access token without refreshing", async () => {
    const h = harness({ access: fresh, refresh: "rt" });
    const outcome = await h.run();
    expect(outcome.kind).toBe("ok");
    expect(h.refreshTokens).not.toHaveBeenCalled();
    expect(h.call).toHaveBeenCalledWith(fresh);
  });

  it("refreshes proactively when the access token is expired, then persists the new pair", async () => {
    const h = harness({ access: stale, refresh: "rt" });
    const outcome = await h.run();
    expect(outcome.kind).toBe("ok");
    expect(h.refreshTokens).toHaveBeenCalledWith("rt");
    expect(h.persist).toHaveBeenCalledWith(newPair);
    expect(h.call).toHaveBeenCalledWith(newPair.access_token);
  });

  it("refreshes once on a 401 and retries transparently", async () => {
    const h = harness({ access: fresh, refresh: "rt", rejected: [fresh] });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ kind: "ok", result: { status: 200 } });
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("clears the session when the refresh token is rejected", async () => {
    const h = harness({ access: stale, refresh: "rt", refreshOutcome: { kind: "invalid" } });
    expect((await h.run()).kind).toBe("unauthenticated");
    expect(h.clear).toHaveBeenCalled();
    expect(h.call).not.toHaveBeenCalled();
  });

  it("keeps cookies when the backend is merely unreachable", async () => {
    const h = harness({ access: undefined, refresh: "rt", refreshOutcome: { kind: "unavailable" } });
    expect((await h.run()).kind).toBe("unavailable");
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("asks a Server Component render to hand off to the refresh route instead of writing cookies", async () => {
    const h = harness({ access: fresh, refresh: "rt", rejected: [fresh], canPersist: false });
    expect((await h.run()).kind).toBe("needs-refresh");
    expect(h.refreshTokens).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("reports unauthenticated when there is no session at all", async () => {
    const h = harness({});
    expect((await h.run()).kind).toBe("unauthenticated");
    expect(h.call).not.toHaveBeenCalled();
  });

  it("gives up after one refresh if the new token is also rejected", async () => {
    const h = harness({ access: fresh, refresh: "rt", rejected: [fresh, newPair.access_token] });
    expect((await h.run()).kind).toBe("unauthenticated");
    expect(h.refreshTokens).toHaveBeenCalledTimes(1);
    expect(h.clear).toHaveBeenCalled();
  });

  it("surfaces network failures (status 0) as unavailable", async () => {
    const h = harness({ access: fresh, refresh: "rt" });
    h.call.mockResolvedValueOnce({ status: 0, token: fresh });
    expect((await h.run()).kind).toBe("unavailable");
  });
});
