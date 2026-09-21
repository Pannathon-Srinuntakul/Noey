import { useEffect } from 'react'
import { useStableCallback } from '../../../lib/useStableCallback'

/**
 * One window `keydown` listener for the editor's lifetime, calling the newest
 * `handler`.
 *
 * The editor's shortcuts used to re-bind on a hand-kept list of the state they
 * read, and anything missing from the list was read stale: caption lines were
 * not on it, so Ctrl+S after a caption edit rendered the lines as they were
 * before the edit. Binding once and calling through to the newest handler
 * leaves no list to get wrong — and no re-bind on every cut edit.
 */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void): void {
  const onKeyDown = useStableCallback(handler)
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])
}
