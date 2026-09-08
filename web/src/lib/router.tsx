/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design; splitting `useRouter` into its own module would
 * force a circular import back to the context defined here. */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { sameRoute, type Route } from './routes'

interface RouterApi {
  route: Route
  navigate: (route: Route) => void
  back: () => void
  canGoBack: boolean
}

const RouterContext = createContext<RouterApi | null>(null)

export function RouterProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [stack, setStack] = useState<Route[]>([{ name: 'projects' }])

  const navigate = useCallback((next: Route) => {
    setStack((prev) => {
      // Re-navigating to the identical route is a no-op rather than a stack
      // entry, so `back` never has to unwind duplicates.
      if (sameRoute(prev[prev.length - 1], next)) return prev
      return [...prev, next]
    })
  }, [])

  const back = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  const api = useMemo<RouterApi>(
    () => ({ route: stack[stack.length - 1], navigate, back, canGoBack: stack.length > 1 }),
    [stack, navigate, back]
  )

  return <RouterContext.Provider value={api}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterApi {
  const ctx = useContext(RouterContext)
  if (!ctx) throw new Error('useRouter must be used inside <RouterProvider>')
  return ctx
}
