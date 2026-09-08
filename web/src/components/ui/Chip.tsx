import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

type ChipCore = {
  selected?: boolean
  dense?: boolean
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>

type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

export type ChipProps = ChipCore & DisabledSlice

/**
 * Segmented/chip control. Never a pill — that shape is reserved for chips only
 * (tabs use an underline, see Tabs.tsx).
 *
 * A disabled chip carries its reason as a **tooltip**, not as adjacent text
 * (HANDOFF §3: adjacent 12px reason is the disabled *button* contract; chips
 * and tabs use a tooltip). Rows of chips are dense, and inline reasons on each
 * one push the row apart and repeat themselves.
 */
export function Chip({
  selected = false,
  dense = false,
  children,
  disabled,
  disabledReason,
  className,
  ...rest
}: ChipProps): React.JSX.Element {
  const isDisabled = disabled === true

  const button = (
    <button
      type="button"
      disabled={isDisabled}
      aria-pressed={selected}
      // Disabled controls swallow pointer events, which would stop the wrapper
      // from ever seeing the hover that opens the tooltip.
      className={cn(
        'inline-flex items-center rounded-md px-3.5 text-sm transition-colors duration-state ease-out disabled:cursor-not-allowed',
        dense ? 'h-8' : 'h-9',
        selected
          ? 'border border-accent bg-accent-tint font-semibold text-accent'
          : 'border border-border text-ink-3 hover:border-border-strong hover:bg-[rgb(243_242_242_/_0.06)]',
        isDisabled &&
          'pointer-events-none border-border-faint text-[rgb(243_242_242_/_0.4)] hover:border-border-faint hover:bg-transparent',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )

  if (isDisabled && disabledReason) {
    return <Tooltip content={disabledReason}>{button}</Tooltip>
  }
  return button
}
