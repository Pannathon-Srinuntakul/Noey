import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Lock } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface ChoiceMenuOption {
  value: string
  /** The name on the trigger and at the top of the row. */
  label: string
  /** The one line under the name, inside the menu. */
  description: string
  /** Set when the plan may not pick this option. The row STAYS in the list,
   * not selectable, with a lock and this reason in place of `description` —
   * an option that is simply absent teaches nobody that it exists. */
  lockedReason?: string
}

/**
 * A trigger button that opens a listbox of rows, each carrying a name AND its
 * one-line description (R19.1).
 *
 * Why not `Segmented`, which these rows used to be: a two-button rail can only
 * show the SELECTED option's description, so comparing two tiers means clicking
 * one to read about it and clicking back. It also has no room for a third tier
 * without squeezing every label. Why not `Select`: its options are one line of
 * text each, with no place for a description, a lock or a shortcut.
 *
 * Keyboard: ↓/↑ on the closed trigger opens it, arrows walk the rows (wrapping),
 * a digit picks the row showing that digit, Escape closes and hands focus back
 * to the trigger, Tab closes and moves on. A pointer press outside closes it.
 */
export function ChoiceMenu({
  ariaLabel,
  value,
  options,
  onChange,
  onLockedAction,
  lockedActionLabel = 'ดูแผน'
}: {
  ariaLabel: string
  value: string
  options: ChoiceMenuOption[]
  onChange: (value: string) => void
  /** Where a locked row sends the user. Without it the locked row is inert —
   * still listed and still explained, but not a button that leads nowhere. */
  onLockedAction?: () => void
  lockedActionLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listId = useId()
  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  const pick = (o: ChoiceMenuOption): void => {
    if (o.lockedReason) {
      if (!onLockedAction) return
      setOpen(false)
      onLockedAction()
      return
    }
    onChange(o.value)
    close(true)
  }

  // Outside press only. Escape and the arrows are handled on the root, which
  // always holds focus while the menu is open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  // Opening puts focus on the current choice, so the first arrow key moves
  // from where the user already is.
  useEffect(() => {
    if (!open) return
    rowRefs.current[selectedIndex >= 0 ? selectedIndex : 0]?.focus()
  }, [open, selectedIndex])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
      return
    }
    // Focus is leaving the menu, so the menu goes with it — but the browser
    // still gets to decide where Tab lands.
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (/^[1-9]$/.test(e.key)) {
      const o = options[Number(e.key) - 1]
      // Only a row that SHOWS its digit answers to it: a locked row spends
      // that slot on the upgrade link, so its number is never an affordance.
      if (o && !o.lockedReason) {
        e.preventDefault()
        pick(o)
      }
      return
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const from = rowRefs.current.findIndex((el) => el === document.activeElement)
    const base = from < 0 ? 0 : from
    rowRefs.current[(base + step + options.length) % options.length]?.focus()
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative w-full max-w-[300px]">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[38px] w-full items-center gap-2.5 rounded-md border bg-transparent px-3 text-left text-sm text-ink transition-colors duration-state ease-out',
          // Open keeps the accent border — it says "this menu is showing", not
          // "this is focused"; focus itself is the global outline (see Select).
          open ? 'border-accent' : 'border-border hover:border-border-strong'
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? ''}</span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-[calc(100%+4px)] z-50 w-full rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface p-1.5 shadow-modal sm:w-[340px]"
        >
          {options.map((o, i) => {
            const isOn = o.value === value
            const locked = Boolean(o.lockedReason)
            return (
              <button
                key={o.value}
                ref={(el) => {
                  rowRefs.current[i] = el
                }}
                type="button"
                role="option"
                aria-selected={isOn}
                // Not `disabled`: the row is still worth reaching, reading and
                // pressing — it is the way to the plans screen.
                aria-disabled={locked || undefined}
                disabled={locked && !onLockedAction}
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-[3px] px-2.5 py-2 text-left transition-colors duration-state ease-out',
                  locked
                    ? 'text-[rgb(243_242_242_/_0.4)] hover:bg-[rgb(243_242_242_/_0.04)]'
                    : 'text-ink-3 hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink'
                )}
              >
                <span className="mt-[3px] flex w-[15px] shrink-0 justify-start">
                  {locked ? (
                    <Lock size={12} aria-hidden />
                  ) : isOn ? (
                    <Check size={13} className="text-accent" strokeWidth={2.2} aria-hidden />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className={cn('text-sm font-medium', locked ? '' : 'text-ink')}>
                    {o.label}
                  </span>
                  <span className="text-[12.5px] leading-[1.55] text-muted">
                    {o.lockedReason ?? o.description}
                  </span>
                </span>
                {/* The right-hand slot is the shortcut, or — on a locked row,
                    which has no shortcut — where the upgrade goes. */}
                <span
                  className={cn(
                    'mt-[2px] shrink-0 text-[12px]',
                    locked ? 'text-accent' : 'tabular-nums text-muted'
                  )}
                >
                  {locked ? (onLockedAction ? lockedActionLabel : '') : i + 1}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
