/** Route shape + pure helpers. Kept separate from `router.tsx` so that file
 * exports components only (Fast Refresh requirement). */

/** The 9 screens from the prototype. `login` is handled outside the router
 * (there is no session to route within), so it is not a route here. */
export type Route =
  | { name: 'projects' }
  | { name: 'progress'; uid: string }
  | { name: 'detail'; uid: string }
  // `initialFiles` lets another screen hand the wizard clips it already has
  // (phone-receive started from the projects page), so those files are not
  // stranded in the inbox with nothing pointing at them.
  | { name: 'wizard'; initialFiles?: { path: string; name: string }[] }
  | { name: 'timeline'; uid: string }
  | { name: 'effectsClip'; uid: string }
  | { name: 'voiceover'; uid: string }
  | { name: 'library'; category?: 'cutStyles' | 'zoomStyles' }
  | { name: 'settings' }

export type RouteName = Route['name']

/** Editor-style screens drop the left nav for a 56px toolbar (HANDOFF §4). */
const FULL_BLEED: ReadonlySet<RouteName> = new Set([
  'timeline',
  'effectsClip',
  'voiceover',
  'wizard'
])

export function routeHasNav(route: Route): boolean {
  return !FULL_BLEED.has(route.name)
}

/** Which nav item renders as current — detail and progress live under
 * โปรเจกต์ rather than being nav destinations of their own. */
export function navGroupFor(route: Route): 'projects' | 'library' | 'settings' | null {
  switch (route.name) {
    case 'projects':
    case 'detail':
    case 'progress':
      return 'projects'
    case 'library':
      return 'library'
    case 'settings':
      return 'settings'
    default:
      return null
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false
  return ('uid' in a ? a.uid : null) === ('uid' in b ? b.uid : null)
}
