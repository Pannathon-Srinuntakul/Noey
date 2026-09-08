import { useEffect, useState } from 'react'

/**
 * Layout breakpoints, matching Tailwind's so a class and a hook never disagree
 * about where a layout changes.
 *
 * The desktop layout is the design; these exist only to let it survive a
 * narrower window. Nothing at or above `lg` changes shape.
 */
export const BREAKPOINT = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280
} as const

/** True while the media query matches. Re-evaluates on resize and rotation. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    // Read once on mount too: the query can already differ from the initial
    // state if the window was resized between render and effect.
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Narrower than Tailwind's `md` — where the nav rail stops fitting beside the page. */
export function useIsCompact(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINT.md - 1}px)`)
}

/** Narrower than `lg` — where two-column screens have to stack. */
export function useIsNarrow(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINT.lg - 1}px)`)
}
