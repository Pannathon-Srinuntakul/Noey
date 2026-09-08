/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design; splitting `usePrefs` into its own module would
 * force a circular import back to the context defined here. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Prefs } from '@renderer/platform/types'

interface PrefsApi {
  /** Null until the first read resolves — screens that need a real value
   * should render a loading state rather than assume a default. */
  prefs: Prefs | null
  /** Writes through to disk and updates every consumer. */
  update: (patch: Partial<Prefs>) => Promise<void>
}

const PrefsContext = createContext<PrefsApi | null>(null)

export function PrefsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.noey.prefs.get().then((p) => {
      if (!cancelled) setPrefs(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (patch: Partial<Prefs>) => {
    // The main process returns the merged result, so the renderer never has to
    // guess how a partial write landed (coercion, unknown-key passthrough).
    setPrefs(await window.noey.prefs.set(patch))
  }, [])

  const api = useMemo<PrefsApi>(() => ({ prefs, update }), [prefs, update])
  return <PrefsContext.Provider value={api}>{children}</PrefsContext.Provider>
}

export function usePrefs(): PrefsApi {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used inside <PrefsProvider>')
  return ctx
}
