import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface MenuItemDef {
  key: string
  label: string
  /** Second line under the label, for a detail the row would be ambiguous
   * without — e.g. which round "ย้อนกลับคลิปก่อนหน้า" would bring back. */
  sublabel?: string
  icon?: ReactNode
  destructive?: boolean
  disabled?: boolean
}

export interface MenuProps {
  items: (MenuItemDef | { divider: true })[]
  onSelect: (key: string) => void
  className?: string
}

/** The styled panel + rows only — positioning (anchor to a trigger, or a
 * context-click point) and open/close/outside-click are the caller's, since
 * that genuinely differs per usage. */
export function Menu({ items, onSelect, className }: MenuProps): React.JSX.Element {
  return (
    <div
      role="menu"
      className={cn(
        'z-50 w-[210px] rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface p-1.5 shadow-modal',
        className
      )}
    >
      {items.map((item, i) =>
        'divider' in item ? (
          <div key={`divider-${i}`} className="my-[5px] border-t border-divider" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => onSelect(item.key)}
            className={cn(
              // Disabled is a text COLOUR, not opacity on the row — fading the
              // whole button takes the icon with it and drops below the 60%
              // text-opacity floor (HANDOFF §2).
              'flex w-full gap-2 rounded-[3px] px-2.5 text-left text-sm transition-colors duration-state ease-out disabled:cursor-not-allowed disabled:text-[rgb(243_242_242_/_0.4)]',
              // A two-line row cannot keep the fixed 36px height; only that
              // row changes, so every ordinary item stays pixel-identical.
              item.sublabel ? 'items-start py-1.5' : 'h-9 items-center',
              item.destructive
                ? 'text-error hover:bg-[rgb(224_139_132_/_0.1)]'
                : 'text-ink-3 hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink'
            )}
          >
            {item.icon ? (
              <span className={cn('shrink-0', item.sublabel && 'mt-[3px]')}>{item.icon}</span>
            ) : null}
            {item.sublabel ? (
              <span className="flex min-w-0 flex-col items-start gap-px">
                <span className="truncate">{item.label}</span>
                <span className="truncate text-[12.5px] tabular-nums text-muted">
                  {item.sublabel}
                </span>
              </span>
            ) : (
              item.label
            )}
          </button>
        )
      )}
    </div>
  )
}
