import type { Session } from '../App'
import { ApiError, restoreSession } from './api'
import { emitTokens } from './sessionBus'

/**
 * Call an account endpoint with the session's token, refreshing it once on a
 * 401 — the settings screen is often the first thing opened after a long
 * idle, when the access token has lapsed.
 */
export async function withFreshToken<T>(
  session: Session,
  call: (baseUrl: string, accessToken: string) => Promise<T>
): Promise<T> {
  let accessToken = session.accessToken
  try {
    return await call(session.baseUrl, accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
  }
  const pair = await restoreSession(session.baseUrl, accessToken, session.refreshToken)
  if (!pair) throw new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
  accessToken = pair.access_token
  await window.noey.auth.save({
    baseUrl: session.baseUrl,
    email: session.profile.email,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token
  })
  // Storage alone left React state and the service worker on the dead token;
  // the bus hands the pair to App, which updates both.
  emitTokens(pair.access_token, pair.refresh_token)
  return call(session.baseUrl, accessToken)
}
