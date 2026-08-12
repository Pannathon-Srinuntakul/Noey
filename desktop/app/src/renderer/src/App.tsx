import { useCallback, useEffect, useMemo, useState } from 'react'
import { me, restoreSession, type Me } from './lib/api'
import type { ApiSession } from './lib/videosLocalApi'
import { ConfirmProvider } from './lib/confirm'
import { JobsProvider } from './lib/jobs'
import { PrefsProvider } from './lib/prefs'
import { RouterProvider } from './lib/router'
import { ToastProvider } from './lib/toast'
import { AppShell } from './components/shell/AppShell'
import { RouteView } from './components/shell/RouteView'
import { TitleBar } from './components/shell/TitleBar'
import DevUiPage from './pages/DevUiPage'
import LoginPage from './pages/LoginPage'

// Backend URL is baked in at build time — users never see or set it.
// Override for local dev/self-hosting: VITE_BACKEND_URL=... npm run build
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'https://noey-api-production.up.railway.app'

export interface Session {
  baseUrl: string
  accessToken: string
  refreshToken: string
  profile: Me
}

function Workspace({
  session,
  onLogout
}: {
  session: Session
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
      }
    }),
    [session]
  )

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
              <AppShell session={session}>
                <RouteView session={session} onLogout={onLogout} />
              </AppShell>
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
  if (session) return <Workspace session={session} onLogout={logout} />

  return (
    <div className="flex h-full flex-col bg-ground">
      <TitleBar label="Noey Video Edit" />
      {/* Must be a flex container: the children below fill and centre
          themselves with `flex-1`, which is inert under a plain block parent
          (the box then collapses to content height and nothing centres). */}
      <div className="flex min-h-0 flex-1 flex-col">
        {restoring ? (
          <div className="flex flex-1 items-center justify-center bg-ground text-sm text-muted">
            กำลังโหลด…
          </div>
        ) : (
          <LoginPage backendUrl={BACKEND_URL} onLogin={setSession} />
        )}
      </div>
    </div>
  )
}

export default App
