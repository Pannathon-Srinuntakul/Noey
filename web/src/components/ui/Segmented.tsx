import { Fragment, useRef } from 'react'
import { cn } from '../../lib/cn'
import { nextSegmentedIndex } from '../../lib/segmented'

export interface SegmentedOption {
  value: string
  label: React.ReactNode
  /** Spoken name, for an option whose label carries an icon. */
  ariaLabel?: string
  /** Digits only line up when the label is a number ("30 วิ"), not on prose. */
  numeric?: boolean
}

/**
 * One rail, one value (R14.1).
 *
 * The shape is the affordance: a single joined rail says "pick exactly one of
 * these", the way a row of separate boxes says "tick as many as you like". The
 * wizard used the same `Chip` for both, so "สไตล์สคริปต์" (multi) looked
 * identical to "ความยาว" (single) and only a 12px hint told them apart.
 *
 * The rail is NOT `overflow-hidden` even though it reads as one box: the global
 * `*:focus-visible` outline sits 2px outside its element, and an ancestor with
 * hidden overflow clips it away. The end options carry the rounding instead,
 * which looks the same and keeps the focus ring visible.
 */
export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  className
}: {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  className?: string
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.findIndex((o) => o.value === value)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = nextSegmentedIndex(e.key, current, options.length)
    if (next === null) return
    e.preventDefault()
    onChange(options[next].value)
    // Focus follows the value — a radiogroup that changed its selection while
    // leaving focus behind would strand the next arrow key on the old index.
    rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        // Wraps. The web copy added `shrink-0`, which desktop does not have, so the
        // rail had one intrinsic width and could neither shrink nor wrap: the
        // เสียง rail is ~424px against ~314px of control cell at 390. Each option
        // keeps its own h-[34px], so a wrapped row still looks like a rail.
        'inline-flex min-h-[34px] max-w-full flex-wrap items-center rounded-md border border-border-faint',
        className
      )}
    >
      {options.map((o, i) => {
        const on = i === current
        return (
          <Fragment key={o.value}>
            {i > 0 ? <span aria-hidden className="h-[34px] w-px bg-divider" /> : null}
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={o.ariaLabel}
              // Roving tabindex: the group is one tab stop. With nothing
              // selected the first option holds it, so the group is still
              // reachable.
              tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex h-[34px] items-center gap-2 whitespace-nowrap px-3.5 text-sm transition-colors duration-state ease-out',
                i === 0 && 'rounded-l-[5px]',
                i === options.length - 1 && 'rounded-r-[5px]',
                o.numeric && 'tabular-nums',
                on
                  ? 'bg-accent-tint font-semibold text-accent'
                  : 'text-ink-2 hover:bg-[rgb(243_242_242_/_0.05)]'
              )}
            >
              {o.label}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
