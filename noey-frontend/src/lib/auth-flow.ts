/**
 * Transparent token refresh, as a pure orchestrator. The server wrappers
 * inject the real backend calls and cookie writes; the unit tests inject
 * mocks. No Next.js import here on purpose.
 */
import { isTokenFresh, type TokenPair } from "./session";

export type RefreshOutcome =
  | { kind: "ok"; tokens: TokenPair }
  /** Backend rejected the refresh token (401/403): the session is over. */
  | { kind: "invalid" }
  /** Backend unreachable or 5xx: the tokens may still be fine, do not clear them. */
  | { kind: "unavailable" };

export interface StatusResult {
  status: number;
}

export type AuthedOutcome<R> =
  | { kind: "ok"; result: R }
  /** No usable session: send the user to /login. */
  | { kind: "unauthenticated" }
  /** A refresh is needed but this context cannot write cookies (Server Component render). */
  | { kind: "needs-refresh" }
  /** The backend could not be reached. */
  | { kind: "unavailable" };

export interface AuthedCallOptions<R extends StatusResult> {
  access: string | undefined;
  refresh: string | undefined;
  /** Server Actions and Route Handlers can write cookies; Server Component renders cannot. */
  canPersist: boolean;
  call: (accessToken: string) => Promise<R>;
  refreshTokens: (refreshToken: string) => Promise<RefreshOutcome>;
  persist: (tokens: TokenPair) => void | Promise<void>;
  clear: () => void | Promise<void>;
  nowSeconds?: number;
}

/** Network failures are reported by the API client as status 0. */
function isUnavailable(result: StatusResult): boolean {
  return result.status === 0;
}

export async function callWithRefresh<R extends StatusResult>(options: AuthedCallOptions<R>): Promise<AuthedOutcome<R>> {
  const { refresh, canPersist } = options;
  let access = options.access;
  let refreshed = false;

  if (!access && !refresh) return { kind: "unauthenticated" };

  const doRefresh = async (): Promise<AuthedOutcome<R> | null> => {
    if (!refresh) return { kind: "unauthenticated" };
    if (!canPersist) return { kind: "needs-refresh" };
    const outcome = await options.refreshTokens(refresh);
    if (outcome.kind === "invalid") {
      await options.clear();
      return { kind: "unauthenticated" };
    }
    if (outcome.kind === "unavailable") return { kind: "unavailable" };
    await options.persist(outcome.tokens);
    access = outcome.tokens.access_token;
    refreshed = true;
    return null;
  };

  // Proactive: a missing or nearly expired access token is renewed first.
  if (!isTokenFresh(access, options.nowSeconds)) {
    if (refresh && canPersist) {
      const stop = await doRefresh();
      // Refresh endpoint down but we still hold an access token: try it anyway.
      if (stop && !(stop.kind === "unavailable" && access)) return stop;
    } else if (!access) {
      return refresh ? { kind: "needs-refresh" } : { kind: "unauthenticated" };
    }
  }

  if (!access) return { kind: "unauthenticated" };
  let result = await options.call(access);
  if (isUnavailable(result)) return { kind: "unavailable" };

  // Reactive: the backend still said 401 (revoked, clock skew…) — refresh once.
  if (result.status === 401 && !refreshed) {
    const stop = await doRefresh();
    if (stop) return stop;
    result = await options.call(access);
    if (isUnavailable(result)) return { kind: "unavailable" };
  }
  if (result.status === 401) {
    if (canPersist) await options.clear();
    return { kind: "unauthenticated" };
  }
  return { kind: "ok", result };
}
