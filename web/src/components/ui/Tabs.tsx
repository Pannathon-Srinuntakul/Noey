import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

export interface TabItem {
  key: string
  label: string
  disabled?: boolean
  /** Required when `disabled` — shown as a tooltip, never dropped silently. */
  disabledReason?: string
}

export interface TabsProps {
  items: TabItem[]
  activeKey: string
  onChange: (key: string) => void
  className?: string
}

/** Underline tabs on a divider — never a pill, that shape belongs to Chip. */
export function Tabs({ items, activeKey, onChange, className }: TabsProps): React.JSX.Element {
  return (
    <div className={cn('flex gap-5 border-b border-divider', className)}>
      {items.map((item) => {
        const isActive = item.key === activeKey
        const tab = (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={cn(
              'flex h-[34px] items-center text-sm transition-colors duration-state ease-out disabled:cursor-not-allowed',
              item.disabled
                ? 'text-[rgb(243_242_242_/_0.4)]'
                : isActive
                  ? 'font-semibold text-accent shadow-[inset_0_-2px_0_var(--color-accent)]'
                  : 'text-muted hover:text-ink hover:shadow-[inset_0_-2px_0_rgb(243_242_242_/_0.28)]'
            )}
          >
            {item.label}
          </button>
        )

        if (item.disabled && item.disabledReason) {
          return (
            <Tooltip key={item.key} content={item.disabledReason}>
              {tab}
            </Tooltip>
          )
        }
        return tab
      })}
    </div>
  )
}
