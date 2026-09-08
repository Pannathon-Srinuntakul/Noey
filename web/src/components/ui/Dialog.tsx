import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  /** Canonical widths per HANDOFF §3 Dialog: 560 confirm · 620
   * checklist/shortcuts · 680 caption style / generate · 720 create
   * style / receive-from-phone. */
  width: number
  children: React.ReactNode
  /** Left-aligned footer note, e.g. "เลือกไว้ 2 ไฟล์". */
  footerNote?: React.ReactNode
  /** Right-aligned footer buttons — caller composes ghost + primary Button. */
  footerActions?: React.ReactNode
  /** Enter confirms, unless focus is inside a <textarea>. */
  onConfirm?: () => void
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  width,
  children,
  footerNote,
  footerActions,
  onConfirm
}: DialogProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Enter' && onConfirm && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        e.stopPropagation()
        onConfirm()
        return
      }
      if (e.key === 'Tab') {
        const panel = panelRef.current
        if (!panel) return
        const focusable = panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused.current?.focus()
    }
  }, [open, onClose, onConfirm])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(23_22_20_/_0.72)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        // The handoff's widths are exact on a desktop window and a ceiling on
        // anything narrower — a 620px dialog on a 390px screen is a dialog with
        // its buttons off the edge.
        style={{ width, maxWidth: 'calc(100vw - 32px)' }}
        className="noey-dialog-enter flex max-h-[calc(100dvh-64px)] flex-col rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-modal outline-none"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5">
          <div>
            <h2 id="dialog-title" className="text-2xl font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="ปิด"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-[rgb(243_242_242_/_0.06)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footerNote || footerActions ? (
          <div
            className={cn(
              // Wraps below `sm`, and the NOTE is what yields: the buttons are
              // shrink-0 whitespace-nowrap (Button.tsx), so on a 360px panel a
              // Thai footer note plus a primary and its disabled reason came to
              // more than the row could hold and the primary left the panel.
              'flex flex-wrap items-center justify-end gap-3 border-t border-divider px-5 py-4',
              'sm:flex-nowrap sm:justify-between sm:gap-4 sm:px-6'
            )}
          >
            <span className="min-w-0 flex-1 text-sm text-muted">{footerNote}</span>
            <div className="flex items-center gap-3">{footerActions}</div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
