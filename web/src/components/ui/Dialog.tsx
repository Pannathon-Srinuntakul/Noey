import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { cycleTab, enterConfirms, useModalFocus } from './focusTrap'

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
  /** Enter confirms, unless focus is inside a <textarea> or on a control
   * that has its own Enter meaning (see `enterConfirms`). */
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
  // A unique id per instance: two dialogs on one page (a confirm over a
  // form dialog) shared the literal "dialog-title", so aria-labelledby on the
  // upper one could resolve to the lower one's heading.
  const titleId = useId()
  // The callbacks live in refs so the keydown effect keys on `open` alone.
  // Callers pass inline arrows, which are new on every render — keyed on
  // them, the effect tore down and re-ran on each render, and its cleanup
  // (`previouslyFocused.focus()`) yanked focus back to the opener while the
  // dialog was still up.
  const onCloseRef = useRef(onClose)
  const onConfirmRef = useRef(onConfirm)
  useEffect(() => {
    onCloseRef.current = onClose
    onConfirmRef.current = onConfirm
  })

  useModalFocus(open, panelRef)

  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key === 'Enter' && onConfirmRef.current && enterConfirms(e.target)) {
        e.stopPropagation()
        onConfirmRef.current()
        return
      }
      if (e.key === 'Tab' && panelRef.current) cycleTab(panelRef.current, e)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

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
        aria-labelledby={titleId}
        tabIndex={-1}
        // The handoff's widths are exact on a desktop window and a ceiling on
        // anything narrower — a 620px dialog on a 390px screen is a dialog with
        // its buttons off the edge.
        style={{ width, maxWidth: 'calc(100vw - 32px)' }}
        className="noey-dialog-enter flex max-h-[calc(100dvh-64px)] flex-col rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-modal outline-none"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5">
          <div>
            <h2 id={titleId} className="text-2xl font-semibold text-ink">
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
