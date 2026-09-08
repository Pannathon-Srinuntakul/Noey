/**
 * Session events that cross component boundaries.
 *
 * WEB ONLY. Three places refresh a token outside the App component (the shared
 * request helper, `authedFetch`, and the settings page's private path), and
 * two of them used to write ONLY to storage — React state and the service
 * worker kept the dead token, so the first media read after their refresh
 * 401'd anyway. And when a refresh itself failed, nothing ended the session:
 * the user sat on a workspace where every call failed with an English server
 * detail, with no path back but a manual reload.
 *
 * A window event, not a context: the emitters are plain modules with no access
 * to React, and the ONE listener that matters (App) owns both the state and
 * the worker.
 */

export interface TokenEvent {
  accessToken: string
  refreshToken: string
}

const TOKENS = 'noey:tokens'
const AUTH_LOST = 'noey:auth-lost'

/** A refresh succeeded somewhere — App updates state, storage and the worker. */
export function emitTokens(accessToken: string, refreshToken: string): void {
  window.dispatchEvent(
    new CustomEvent<TokenEvent>(TOKENS, { detail: { accessToken, refreshToken } })
  )
}

/** A refresh FAILED — the session is over and the app must say so. */
export function emitAuthLost(): void {
  window.dispatchEvent(new Event(AUTH_LOST))
}

export function onTokens(cb: (t: TokenEvent) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<TokenEvent>).detail)
  window.addEventListener(TOKENS, handler)
  return () => window.removeEventListener(TOKENS, handler)
}

export function onAuthLost(cb: () => void): () => void {
  window.addEventListener(AUTH_LOST, cb)
  return () => window.removeEventListener(AUTH_LOST, cb)
}
