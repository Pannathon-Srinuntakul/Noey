import { useEffect } from 'react'
import { useStableCallback } from '../../../lib/useStableCallback'

/**
 * One window `keydown` listener for the editor's lifetime, calling the newest
 * `handler` — and, when given, one `keyup` listener the same way, so a
 * held-key burst (a nudge repeated by key auto-repeat) has an end.
 *
 * The editor's shortcuts used to re-bind on a hand-kept list of the state they
 * read, and anything missing from the list was read stale: caption lines were
 * not on it, so Ctrl+S after a caption edit rendered the lines as they were
 * before the edit. Binding once and calling through to the newest handler
 * leaves no list to get wrong — and no re-bind on every cut edit.
 */
export function useWindowKeydown(
  handler: (e: KeyboardEvent) => void,
  keyup?: (e: KeyboardEvent) => void
): void {
  const onKeyDown = useStableCallback(handler)
  // Stable whether or not a keyup handler is given, so the effect binds once.
  const onKeyUp = useStableCallback((e: KeyboardEvent) => keyup?.(e))
  const hasKeyUp = !!keyup
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    if (hasKeyUp) window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (hasKeyUp) window.removeEventListener('keyup', onKeyUp)
    }
  }, [onKeyDown, onKeyUp, hasKeyUp])
}
