/**
 * The page load that comes back from Google (`/auth/google/callback`).
 *
 * Runs ONCE per page load (memoised): React's StrictMode runs the boot effect
 * twice in development, and the second run would find the kept `state`
 * already spent and report a mismatch.
 *
 * Order matters and follows docs/google-sign-in.md:
 *   1. read the query, then strip it from the address bar at once — the
 *      one-time `code` must not sit in history, a bookmark or a Referer;
 *   2. an `error` return (the person cancelled) never calls the API;
 *   3. the returned `state` must equal the one this tab kept, exactly;
 *   4. only then POST the code to the API, which holds the PKCE verifier.
 */

import { ApiError, googleCallback, me, restoreSession, type Me } from './api'
import {
  GOOGLE_CANCELLED_TEXT,
  GOOGLE_INVALID_STATE_TEXT,
  googleErrorText,
  googleRedirectUri,
  isGoogleCallbackPath,
  parseGoogleReturn,
  stashGoogleOutcome
} from './googleAuth'
import { isCaptchaCode } from './turnstile'
import type { Route } from './routes'

export interface GoogleBoot {
  /** A new signed-in session (intent signin). */
  signedIn?: {
    accessToken: string
    refreshToken: string
    profile: Me
  }
  /** Shown on the login screen when nobody ends up signed in. */
  loginError?: string
  /** The server refused to CREATE the account without a bot check
   * (`captcha_required` / `captcha_failed`): the login screen shows the
   * Turnstile widget for the retry. */
  needsCaptcha?: boolean
  /** Where the workspace should open (link / reauth return to settings). */
  route?: Route
}

let once: Promise<GoogleBoot | null> | null = null

/** Null when this page load is not a Google return. */
export function handleGoogleReturn(baseUrl: string): Promise<GoogleBoot | null> {
  if (!isGoogleCallbackPath(window.location.pathname)) return Promise.resolve(null)
  once ??= run(baseUrl)
  return once
}

async function run(baseUrl: string): Promise<GoogleBoot> {
  const ret = parseGoogleReturn(window.location.search)
  // Strip `?code=…&state=…` before anything else can read or log the URL.
  // Back to the root: a reload must not re-run a spent callback.
  window.history.replaceState(null, '', '/')

  if (ret.kind === 'no_flow') return { loginError: GOOGLE_INVALID_STATE_TEXT }

  const { flow } = ret
  const redirectUri = googleRedirectUri(window.location.origin)

  if (flow.intent === 'signin') {
    if (ret.kind === 'cancelled') return { loginError: GOOGLE_CANCELLED_TEXT }
    if (ret.kind === 'invalid_state') return { loginError: GOOGLE_INVALID_STATE_TEXT }
    try {
      const res = await googleCallback(baseUrl, {
        code: ret.code,
        state: ret.state,
        redirect_uri: redirectUri
      })
      if (res.intent !== 'signin') return { loginError: GOOGLE_INVALID_STATE_TEXT }
      const profile = await me(baseUrl, res.access_token)
      return {
        signedIn: {
          accessToken: res.access_token,
          refreshToken: res.refresh_token,
          profile
        }
      }
    } catch (err) {
      void window.noey.log.write('google', `sign-in callback failed: ${String(err)}`)
      const needsCaptcha = err instanceof ApiError && isCaptchaCode(err.code)
      return { loginError: googleErrorText(err), ...(needsCaptcha ? { needsCaptcha } : {}) }
    }
  }

  // link / reauth: the person was signed in when they left. Their stored
  // session is restored by the normal boot path afterwards; this only needs a
  // live access token for the SAME user to complete the call.
  const route: Route = { name: 'settings', tab: 'account' }
  if (ret.kind === 'cancelled') {
    stashGoogleOutcome({ kind: 'error', intent: flow.intent, message: GOOGLE_CANCELLED_TEXT })
    return { route }
  }
  if (ret.kind === 'invalid_state') {
    stashGoogleOutcome({ kind: 'error', intent: flow.intent, message: GOOGLE_INVALID_STATE_TEXT })
    return { route }
  }
  const stored = await window.noey.auth.load()
  const pair = stored
    ? await restoreSession(baseUrl, stored.accessToken, stored.refreshToken)
    : null
  if (!stored || !pair) return { loginError: 'เซสชันหมดอายุ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง' }
  if (pair.access_token !== stored.accessToken || pair.refresh_token !== stored.refreshToken) {
    // A refresh ROTATES the pair: the old refresh token is now spent, so the
    // new one must be stored before the boot path reads storage again.
    await window.noey.auth.save({
      ...stored,
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token
    })
  }
  try {
    const res = await googleCallback(
      baseUrl,
      { code: ret.code, state: ret.state, redirect_uri: redirectUri },
      pair.access_token
    )
    if (res.intent === 'link') {
      stashGoogleOutcome({ kind: 'linked', googleEmail: res.google_email })
    } else if (res.intent === 'reauth') {
      stashGoogleOutcome({
        kind: 'reauth',
        reauthToken: res.reauth_token,
        expiresAt: Date.now() + Math.max(0, res.expires_in - 15) * 1000
      })
    }
  } catch (err) {
    void window.noey.log.write('google', `${flow.intent} callback failed: ${String(err)}`)
    stashGoogleOutcome({ kind: 'error', intent: flow.intent, message: googleErrorText(err) })
  }
  return { route }
}
