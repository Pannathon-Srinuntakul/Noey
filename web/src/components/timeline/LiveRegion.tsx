import { forwardRef, useImperativeHandle, useRef } from 'react'

export interface LiveRegionHandle {
  /** Say `text` to assistive tech. Saying the same text twice in a row still
   * reads twice — a zero-width space is appended so the DOM text changes. */
  announce(text: string): void
}

/** A zero-width space: invisible, not spoken, but a different string. */
const ZWSP = '​'

/**
 * The editor's "show me what changed" channel for screen readers: every edit
 * answer the toasts print ('แยกฉาก 3 แล้ว', 'เลิกทำ: ลบฉาก') is also written
 * here. Visually hidden; polite so it never interrupts the transport clock.
 */
// Props are `object`, not `Record<string, never>`: the latter also swallows
// the `ref` key forwardRef adds, so the editor could not pass one.
export const LiveRegion = forwardRef<LiveRegionHandle, object>(function LiveRegion(_props, ref) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const lastRef = useRef<string>('')

  useImperativeHandle(
    ref,
    () => ({
      announce(text) {
        const el = elRef.current
        if (!el) return
        const next = text === lastRef.current ? text + ZWSP : text
        lastRef.current = next
        el.textContent = next
      }
    }),
    []
  )

  return (
    <div
      ref={elRef}
      aria-live="polite"
      aria-atomic="true"
      // Visually hidden, not display:none — a hidden region is not read.
      className="absolute -m-px h-px w-px overflow-hidden border-0 p-0 whitespace-nowrap"
      style={{ clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)' }}
    />
  )
})
