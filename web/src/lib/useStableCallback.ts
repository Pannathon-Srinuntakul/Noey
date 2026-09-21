import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function whose identity never changes but which always runs the newest
 * render's `fn`.
 *
 * For callbacks that outlive the render that made them — a window listener
 * bound once, a flush handed to a hook that keys an effect on it. A plain
 * render-scoped function there either re-binds on every render or goes stale.
 *
 * The wrapper is refreshed in a layout effect, so every handler, effect and
 * animation frame after a commit sees the newest `fn`. Do not CALL it during
 * render: there it still runs the previous render's.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
