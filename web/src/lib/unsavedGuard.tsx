import { useEffect, useRef } from 'react'
import { useConfirm } from './confirm'

/**
 * Guard a screen that holds edits which have NOT been rendered yet.
 *
 * Two exits have to be covered and they are covered differently:
 *
 * - Leaving the screen (the back button, Esc) — the screen calls
 *   `confirmLeave()` before it navigates.
 * - Closing the app — the renderer never sees that, so main cancels the close
 *   and asks us to prompt (see main/unsavedGuard.ts). This hook owns that
 *   round trip so every editor screen behaves the same way.
 *
 * `reason` is null when there is nothing pending; passing null clears the
 * guard, and so does unmounting.
 */
export function useUnsavedGuard(
  reason: string | null,
  /** Write whatever is pending before the app goes away. The leave path flushes
   * on its own; closing the app never touched it, so an edit made inside the
   * autosave debounce died with the process — the one case where the warning
   * was about work that really was still only in memory. */
  flush?: () => Promise<void>
): { confirmLeave: () => Promise<boolean> } {
  const confirm = useConfirm()
  const reasonRef = useRef(reason)
  const flushRef = useRef(flush)

  useEffect(() => {
    reasonRef.current = reason
    flushRef.current = flush
    void window.noey.app.setUnsaved(reason)
  }, [reason, flush])

  // Cleared on unmount as well: a screen that is gone cannot have pending work,
  // and leaving the flag set would block the app from ever closing cleanly.
  useEffect(() => {
    return () => {
      void window.noey.app.setUnsaved(null)
    }
  }, [])

  useEffect(() => {
    return window.noey.app.onCloseRequested((why) => {
      void (async () => {
        const ok = await confirm({
          title: 'ปิดแอปเลยไหม?',
          body: why,
          confirmLabel: 'ปิดแอปเลย',
          cancelLabel: 'อยู่ต่อ',
          destructive: true
        })
        if (ok) {
          // Save first, close second — the draft is the point of the warning.
          await flushRef.current?.().catch(() => undefined)
          await window.noey.app.allowClose()
        } else await window.noey.app.cancelClose()
      })()
    })
  }, [confirm])

  const confirmLeave = async (): Promise<boolean> => {
    const why = reasonRef.current
    if (!why) return true
    return confirm({
      title: 'ออกจากหน้านี้ไหม?',
      body: why,
      confirmLabel: 'ออกเลย',
      cancelLabel: 'อยู่ต่อ'
    })
  }

  return { confirmLeave }
}
