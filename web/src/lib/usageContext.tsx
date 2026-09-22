import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '../App'
import { getUsage, type Usage } from './api'
import { withFreshToken } from './freshToken'
import { UsageContext } from './usageInfo'

/** How often the shell re-reads the limits while the tab is open. */
const REFRESH_MS = 3 * 60_000

/**
 * The account's limits and plan features for every screen that needs them —
 * the near-limit banner (docs/design/editor-limits.md §2), the wizard's
 * pre-upload notices (§4) and the locked controls. Read on mount, when the tab
 * comes back into focus and every few minutes. A failed read keeps the last
 * answer: nothing here is allowed to block work — the server enforces.
 */
export function UsageProvider({
  session,
  children
}: {
  session: Session
  children: React.ReactNode
}): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    withFreshToken(session, getUsage)
      .then((u) => {
        if (!cancelled) setUsage(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // `session` is a new object on every token refresh; the token itself is
    // what matters, and `tick` is the explicit re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.baseUrl, session.accessToken, tick])

  useEffect(() => {
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [refresh])

  const value = useMemo(() => ({ usage, refresh }), [usage, refresh])
  return <UsageContext.Provider value={value}>{children}</UsageContext.Provider>
}
