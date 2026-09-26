/**
 * One refresh at a time, per refresh token.
 *
 * WEB ONLY. Four paths refresh an access token on a 401 — `authedFetch`,
 * `videosLocalApi.request`, the settings page's `withFreshToken` and the
 * `restoreSession` kick App runs when a media read hits a stale token — and
 * each used to call `POST /auth/refresh` on its own. That was merely
 * wasteful while the server handed the same refresh token back every time.
 * It becomes a logout once the server ROTATES refresh tokens: a consumed
 * refresh token is rejected, and reuse revokes the whole session. Two
 * requests that 401 together (the project list and the usage card, on the
 * first click after a long idle) would then race — the second refresh
 * presents a token the first just consumed, the server treats that as theft,
 * and the user is signed out by the app's own concurrency.
 *
 * So the refresh is single-flight: callers holding the same refresh token
 * share one in-flight request, and a caller that arrives with a token that
 * was rotated a moment ago is handed the pair that replaced it instead of
 * presenting the dead one to the server. The second case is real — every
 * session object is updated in place, but a request that was already built
 * before the rotation still carries the old token in its closure.
 */
import { refresh, type TokenPair } from './api'

/** The subset of a session a refresh needs. Both `ApiSession` and App's
 * `Session` satisfy it structurally. */
export interface RefreshableSession {
  baseUrl: string
  refreshToken: string
}

const inFlight = new Map<string, Promise<TokenPair>>()

/**
 * Pairs that replaced a refresh token, kept briefly so a late caller with
 * the old token gets the answer rather than a revocation. Short on purpose:
 * this is a window for requests already in flight, not a token cache.
 */
const ROTATED_TTL_MS = 2 * 60 * 1000
const rotated = new Map<string, { pair: TokenPair; at: number }>()

function recentlyRotated(refreshToken: string): TokenPair | null {
  const hit = rotated.get(refreshToken)
  if (!hit) return null
  if (Date.now() - hit.at > ROTATED_TTL_MS) {
    rotated.delete(refreshToken)
    return null
  }
  return hit.pair
}

/**
 * Refresh the session's tokens, sharing the request with every other caller
 * that holds the same refresh token. Rejects with the server's error when
 * the refresh token is dead — callers decide what that means for the UI
 * (`emitAuthLost`, a Thai message), exactly as before.
 */
export function refreshOnce(session: RefreshableSession): Promise<TokenPair> {
  const key = session.refreshToken
  const replaced = recentlyRotated(key)
  if (replaced) return Promise.resolve(replaced)

  const running = inFlight.get(key)
  if (running) return running

  const request = refresh(session.baseUrl, key)
    .then((pair) => {
      if (pair.refresh_token !== key) rotated.set(key, { pair, at: Date.now() })
      return pair
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}

/** Test hook: forget every in-flight and rotated entry. */
export function resetRefreshState(): void {
  inFlight.clear()
  rotated.clear()
}
