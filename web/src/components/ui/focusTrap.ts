/**
 * Keyboard plumbing shared by the modal surfaces (Dialog, VideoModal).
 *
 * Plain functions plus one hook, in a `.ts` file so the components stay
 * component-only exports for fast refresh.
 */
import { useEffect, type RefObject } from 'react'

/**
 * Elements the Tab trap cycles through. `[disabled]` is excluded because a
 * disabled button is not focusable: with it in the list the trap's "last"
 * could be a disabled primary, `last.focus()` silently did nothing, and Tab
 * left the dialog for the page behind it.
 */
export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Whether an Enter pressed on `target` should fire the dialog's confirm.
 *
 * Not from a textarea (Enter is a newline there), and NOT from a button or a
 * link: those already act on Enter themselves. Before this check a destructive
 * confirm opened by `lib/confirm.tsx` could be confirmed from the CANCEL
 * button — Tab to "ยกเลิก", press Enter, and the dialog ran `onConfirm` (the
 * delete) before the button's own click ran `onClose`.
 */
export function enterConfirms(target: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof Element`: the target can be the
  // document itself (focus on nothing), and this way it is testable without
  // a DOM.
  const el = target as { tagName?: string; matches?: (selector: string) => boolean } | null
  if (!el || typeof el.matches !== 'function') return true
  if (el.tagName === 'TEXTAREA') return false
  return !el.matches('button, a, [role="button"]')
}

/**
 * Keep Tab inside `panel`: wrap from the last focusable to the first and back.
 * Call from a keydown handler once `e.key === 'Tab'` is established.
 */
export function cycleTab(panel: HTMLElement, e: KeyboardEvent): void {
  const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE)
  if (focusable.length === 0) {
    // Nothing to cycle through: keep focus on the panel itself rather than
    // letting Tab reach the page behind the modal.
    e.preventDefault()
    panel.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  // Focus on the panel itself (its initial state) counts as "before first".
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * Move focus into the panel when the modal opens and give it back to whatever
 * had it when the modal closes. The panel must be focusable (`tabIndex={-1}`).
 */
export function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => {
      // Only if the opener is still in the document: restoring focus to a
      // detached node is a no-op that leaves focus on <body>, which is the
      // browser default anyway.
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open, panelRef])
}
