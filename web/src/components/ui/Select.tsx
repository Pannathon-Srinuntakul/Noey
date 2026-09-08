import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface SelectOption {
  value: string
  label: string
}

type SelectCore = {
  options: SelectOption[]
  value: string
  onValueChange: (value: string) => void
  label?: string
  error?: string
  placeholder?: string
  id?: string
  className?: string
  /** Compact row height, for dense inspector rails. */
  dense?: boolean
}

type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

export type SelectProps = SelectCore & DisabledSlice

/**
 * A listbox we draw ourselves, not a native `<select>`.
 *
 * Chromium renders `<select>`'s popup with the OS theme: on Windows that is a
 * light menu with a blue highlight that ignores our tokens, so options came out
 * near-invisible on the dark surface and the highlight fought the focus ring.
 * Option elements cannot be styled reliably enough to fix that, so the popup is
 * ours: a button plus an absolutely-positioned list, closed on outside click,
 * Escape, or a pick.
 */
export function Select({
  options,
  value,
  onValueChange,
  label,
  error,
  placeholder,
  disabled,
  disabledReason,
  id,
  className,
  dense
}: SelectProps): React.JSX.Element {
  const isDisabled = disabled === true
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      {label ? (
        <label htmlFor={id} className="mb-1.5 block text-sm text-muted">
          {label}
        </label>
      ) : null}
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        disabled={isDisabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border bg-transparent pr-3 pl-3 text-left text-ink outline-none transition-colors duration-state ease-out',
          dense ? 'h-8 text-[13px]' : 'h-10 text-[15px]',
          error
            ? 'border-error'
            : open
              ? // Open keeps the accent border (it says "this menu is showing",
                // not "this is focused"); focus itself is the global outline only
                // — see the note in ui/Input.tsx.
                'border-accent'
              : 'border-border hover:border-border-strong',
          'disabled:cursor-not-allowed disabled:border-border-faint disabled:text-[rgb(243_242_242_/_0.4)]',
          className
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', selected ? '' : 'text-muted')}>
          {selected?.label ?? placeholder ?? ''}
        </span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>

      {open && !isDisabled ? (
        <div
          role="listbox"
          className="scroll-ghost absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface p-1.5 shadow-modal"
        >
          {options.map((o) => {
            const isOn = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isOn}
                onClick={() => {
                  onValueChange(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex h-9 w-full items-center gap-2 rounded-[3px] px-2.5 text-left text-sm transition-colors duration-state ease-out',
                  isOn
                    ? 'text-accent'
                    : 'text-ink-3 hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {isOn ? <Check size={14} className="shrink-0" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      {error ? <p className="mt-1.5 text-[13px] text-error">{error}</p> : null}
      {isDisabled && disabledReason ? (
        <p className="mt-1.5 text-xs text-muted">{disabledReason}</p>
      ) : null}
    </div>
  )
}
