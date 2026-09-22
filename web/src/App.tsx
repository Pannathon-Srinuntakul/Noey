import { useCallback, useEffect, useMemo, useState } from 'react'
import { onAuthLost, onTokens } from './lib/sessionBus'
import { me, restoreSession, type Me } from './lib/api'
import type { ApiSession } from './lib/videosLocalApi'
import { ConfirmProvider } from './lib/confirm'
import { FxJobsProvider } from './lib/fxJobs'
import { JobsProvider } from './lib/jobs'
import { PrefsProvider } from './lib/prefs'
import { RouterProvider } from './lib/router'
import { ToastProvider } from './lib/toast'
import { AppShell } from './components/shell/AppShell'
import { RouteView } from './components/shell/RouteView'
import { TitleBar } from './components/shell/TitleBar'
import DevUiPage from './pages/DevUiPage'
import LoginPage from './pages/LoginPage'

import { BACKEND_URL } from './lib/backendUrl'

/**
 * The browser's store is per ORIGIN, not per account. Logging out and signing
 * in as someone else used to land the new account on the previous account's
 * projects -- listed, playable, exportable. The store remembers whose it is,
 * and a different owner starts from an empty one (their own projects come back
 * from the server via restoreMissingProjects).
 */
const STORE_OWNER_KEY = 'noey.storeOwner'

async function ensureStoreOwner(email: string): Promise<void> {
  try {
    const prev = localStorage.getItem(STORE_OWNER_KEY)
    if (prev && prev !== email) {
      await window.noey.storage.clearAll()
    }
    localStorage.setItem(STORE_OWNER_KEY, email)
  } catch {
    // Storage being unavailable must not block login.
  }
}

export interface Session {
  baseUrl: string
  accessToken: string
  refreshToken: string
  profile: Me
}

function Workspace({
  session,
  onSession,
  onLogout
}: {
  session: Session
  onSession: (next: Session) => void
  onLogout: () => void
}): React.JSX.Element {
  const apiSession = useMemo<ApiSession>(
    () => ({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      onTokens: (access, refresh) => {
        window.noey.auth.save({
          baseUrl: session.baseUrl,
          email: session.profile.email,
          accessToken: access,
          refreshToken: refresh
        })
        // Also into React state. The refreshed token used to be written only to
        // storage, so `session.accessToken` never changed — and the service
        // worker, which is handed the token by the effect below, kept the one
        // captured at login. Half an hour into a tab's life every server-backed
        // media read started failing with a 401 the player showed as a missing
        // file.
        onSession({ ...session, accessToken: access, refreshToken: refresh })
      }
    }),
    [session, onSession]
  )

  // The service worker serves `/media/<uid>/…` from browser storage and, when
  // a file is not there, from the server. It cannot read the session itself —
  // a worker has no access to the page's memory — so the origin and the token
  // are handed to it here, and again whenever the token is refreshed.
  useEffect(() => {
    const post = (): void => {
      navigator.serviceWorker?.controller?.postMessage({
        type: 'sw:origin',
        baseUrl: session.baseUrl.replace(/\/+$/, ''),
        token: session.accessToken
      })
    }
    post()
    // A worker that activates after this render would otherwise never be told.
    navigator.serviceWorker?.addEventListener('controllerchange', post)
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', post)
  }, [session.baseUrl, session.accessToken])

  // Provider order matters: JobsProvider fires completion toasts, so it must
  // sit inside ToastProvider. Both sit inside RouterProvider so a toast action
  // or a notification click can navigate. PrefsProvider is outermost — the
  // wizard reads its defaults on mount.
  return (
    <PrefsProvider>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider>
            <JobsProvider session={apiSession}>
              {/* Editor AI work lives here, not in the editors: leaving the
                  screen must not kill a running job (see lib/fxJobs). */}
              <FxJobsProvider>
                <AppShell session={session}>
                  <RouteView session={session} onLogout={onLogout} />
                </AppShell>
              </FxJobsProvider>
            </JobsProvider>
          </RouterProvider>
        </ConfirmProvider>
      </ToastProvider>
    </PrefsProvider>
  )
}

function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [restoring, setRestoring] = useState(true)

  // Tokens refreshed OUTSIDE the shared session object (the settings page's
  // private path, the style library) and refreshes that FAIL both arrive over
  // the bus: App owns the state and the service worker, so it is the one
  // place that can keep every consumer on the live token -- or end the
  // session visibly when there is no live token to be had.
  // A media probe hit an expired token (the worker cannot refresh it). One
  // authenticated request through the refreshing helper renews the pair, and
  // the onTokens wiring below hands it to the worker.
  useEffect(() => {
    let busy = false
    const kick = (): void => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          const raw = localStorage.getItem('noey.auth')
          if (!raw) return
          const stored = JSON.parse(raw) as {
            baseUrl: string
            email: string
            accessToken: string
            refreshToken: string
          }
          const pair = await restoreSession(BACKEND_URL, stored.accessToken, stored.refreshToken)
          if (pair) {
            await window.noey.auth.save({
              ...stored,
              accessToken: pair.access_token,
              refreshToken: pair.refresh_token
            })
            // Only allocate a NEW session object when the tokens actually
            // changed: every identity change re-fires each session-keyed
            // effect app-wide, and a refresh that returns the same pair is
            // common.
            setSession((s) =>
              !s || (s.accessToken === pair.access_token && s.refreshToken === pair.refresh_token)
                ? s
                : { ...s, accessToken: pair.access_token, refreshToken: pair.refresh_token }
            )
          }
        } catch {
          // The next user-driven API call will surface the real state.
        } finally {
          setTimeout(() => {
            busy = false
          }, 30_000)
        }
      })()
    }
    window.addEventListener('noey:media-auth-stale', kick)
    return () => window.removeEventListener('noey:media-auth-stale', kick)
  }, [])

  useEffect(() => {
    const offTokens = onTokens(({ accessToken, refreshToken }) => {
      setSession((s) => (s ? { ...s, accessToken, refreshToken } : s))
    })
    const offLost = onAuthLost(() => {
      window.noey.auth.clear()
      setSession(null)
    })
    return () => {
      offTokens()
      offLost()
    }
  }, [])
  // Temporary — components/ui/* preview page, no login required. See
  // PLAN.md chunk 1. Remove once the redesign ships.
  const [devUi] = useState(() => window.location.hash === '#/dev/ui')

  useEffect(() => {
    const attempt = async (): Promise<void> => {
      const stored = await window.noey.auth.load()
      if (!stored) return
      // Always use the baked-in backend URL, ignoring any older stored value.
      const pair = await restoreSession(BACKEND_URL, stored.accessToken, stored.refreshToken)
      if (!pair) return
      const profile = await me(BACKEND_URL, pair.access_token)
      await window.noey.auth.save({
        ...stored,
        baseUrl: BACKEND_URL,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token
      })
      await ensureStoreOwner(profile.email)
      setSession({
        baseUrl: BACKEND_URL,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        profile
      })
    }
    attempt()
      .catch(() => undefined)
      .finally(() => setRestoring(false))
  }, [])

  const logout = useCallback(() => {
    window.noey.auth.clear()
    setSession(null)
  }, [])

  const onLogin = useCallback(async (next: Session) => {
    await ensureStoreOwner(next.profile.email)
    setSession(next)
  }, [])

  if (devUi) {
    return (
      <div className="flex h-full flex-col">
        <DevUiPage />
      </div>
    )
  }

  // Signed in: AppShell owns the title bar (it needs the current route to
  // label it). Signed out / restoring: render a bare one so the window is
  // still draggable and the OS caption buttons sit on a themed strip.
  if (session) return <Workspace session={session} onSession={setSession} onLogout={logout} />

  return (
    <div className="flex h-full flex-col bg-ground">
      <TitleBar label="Noey Studio" />
      {/* Must be a flex container: the children below fill and centre
          themselves with `flex-1`, which is inert under a plain block parent
          (the box then collapses to content height and nothing centres). */}
      <div className="flex min-h-0 flex-1 flex-col">
        {restoring ? (
          <div className="flex flex-1 items-center justify-center bg-ground text-sm text-muted">
            กำลังโหลด…
          </div>
        ) : (
          <LoginPage backendUrl={BACKEND_URL} onLogin={(next) => void onLogin(next)} />
        )}
      </div>
    </div>
  )
}

export default App
