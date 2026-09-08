import { useMemo, useState } from 'react'
import { NavSectionContext, type NavSection } from '../../lib/navSection'

/** Holds the one sub-nav section a page may publish into the left rail. */
export function NavSectionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [section, setSection] = useState<NavSection | null>(null)
  const value = useMemo(() => ({ section, setSection }), [section])
  return <NavSectionContext.Provider value={value}>{children}</NavSectionContext.Provider>
}
