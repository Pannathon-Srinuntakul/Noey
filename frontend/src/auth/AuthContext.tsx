/**
 * Auth context: holds access token in memory (not localStorage — avoids XSS exposure).
 * Provides login(), logout(), refresh(), and useAuth() hook.
 * Token is stored in memory and in sessionStorage as a second-layer fallback for page
 * reload within the same tab only (sessionStorage is cleared when the tab closes).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { setTokenGetter, setUnauthorizedHandler } from '../api'

const BASE = import.meta.env.VITE_API_URL ?? '/api'

interface AuthState {
  accessToken: string | null
  loading: boolean
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  getToken: () => string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

const ACCESS_KEY = 'noey_access'
const REFRESH_KEY = 'noey_refresh'

function isAccessTokenValid(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
    if (typeof payload.exp !== 'number') return false
    return payload.exp * 1000 > Date.now() + 10_000
  } catch {
    return false
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ accessToken: null, loading: true })
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleRefresh() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    // Refresh 2 minutes before expiry (access TTL = 30 min → refresh at 28 min)
    refreshTimerRef.current = setTimeout(
      () => void doRefresh(),
      (30 * 60 - 120) * 1000,
    )
  }

  const doRefresh = useCallback(async () => {
    const rt = sessionStorage.getItem(REFRESH_KEY)
    if (!rt) {
      sessionStorage.removeItem(ACCESS_KEY)
      setState({ accessToken: null, loading: false })
      return
    }
    try {
      const r = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rt}` },
      })
      if (!r.ok) {
        sessionStorage.removeItem(ACCESS_KEY)
        sessionStorage.removeItem(REFRESH_KEY)
        setState({ accessToken: null, loading: false })
        return
      }
      const { access_token, refresh_token } = await r.json()
      sessionStorage.setItem(ACCESS_KEY, access_token)
      sessionStorage.setItem(REFRESH_KEY, refresh_token)
      setState({ accessToken: access_token, loading: false })
      scheduleRefresh()
    } catch {
      sessionStorage.removeItem(ACCESS_KEY)
      sessionStorage.removeItem(REFRESH_KEY)
      setState({ accessToken: null, loading: false })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: use stored access token only if still valid; otherwise refresh.
  useEffect(() => {
    const at = sessionStorage.getItem(ACCESS_KEY)
    if (at && isAccessTokenValid(at)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore token on mount
      setState({ accessToken: at, loading: false })
      scheduleRefresh()
    } else {
      void doRefresh()
    }
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }
  }, [doRefresh]) // eslint-disable-line react-hooks/exhaustive-deps

  async function login(email: string, password: string) {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))).detail ?? 'Login failed'
      throw new Error(detail)
    }
    const { access_token, refresh_token } = await r.json()
    sessionStorage.setItem(ACCESS_KEY, access_token)
    sessionStorage.setItem(REFRESH_KEY, refresh_token)
    setState({ accessToken: access_token, loading: false })
    scheduleRefresh()
  }

  function clearSession() {
    sessionStorage.removeItem(ACCESS_KEY)
    sessionStorage.removeItem(REFRESH_KEY)
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    setState({ accessToken: null, loading: false })
  }

  function logout() {
    clearSession()
  }

  function getToken() {
    return state.accessToken ?? sessionStorage.getItem(ACCESS_KEY)
  }

  // Register before child effects so the first fetch includes auth + 401 clears session.
  setTokenGetter(getToken)
  setUnauthorizedHandler(clearSession)

  return (
    <AuthContext.Provider value={{ ...state, login, logout, getToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
