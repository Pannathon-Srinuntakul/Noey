/**
 * A sub-nav a page contributes to the app's left rail.
 *
 * The design puts the library's categories in the sidebar under the main nav
 * (R4/R6 screen 1) rather than in a second column inside the page — one place
 * to look for "where am I", at one indent level deeper. The rail lives above
 * the router, so a page publishes its section up here instead of drawing its
 * own column.
 *
 * Only one section exists at a time; a page clears it on unmount. The provider
 * component lives in components/shell/NavSectionProvider.tsx.
 */
import { createContext, useContext, useEffect } from 'react'

export interface NavSectionItem {
  id: string
  label: string
  /** Shown right-aligned; falsy values render nothing (0 is not news). */
  count?: number
}

export interface NavSection {
  title: string
  items: NavSectionItem[]
  activeId: string
  onSelect: (id: string) => void
}

export const NavSectionContext = createContext<{
  section: NavSection | null
  setSection: (s: NavSection | null) => void
}>({ section: null, setSection: () => undefined })

export function useNavSection(): NavSection | null {
  return useContext(NavSectionContext).section
}

/**
 * Publish a section for as long as the calling page is mounted. `deps` is what
 * the caller changes (active id, counts) — the section object is rebuilt every
 * render, so it can never be the dependency itself.
 */
export function usePublishNavSection(build: () => NavSection, deps: unknown[]): void {
  const { setSection } = useContext(NavSectionContext)
  useEffect(() => {
    setSection(build())
    return () => setSection(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
