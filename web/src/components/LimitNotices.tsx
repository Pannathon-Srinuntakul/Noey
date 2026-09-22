import { cn } from '../lib/cn'
import type { LimitNotice } from '../lib/planLadder'

/**
 * The one-line limit notices of docs/design/editor-limits.md §4: a muted
 * "when" label, the sentence, and an optional action link — one bordered row
 * each. The caller decides what an action does (`onAction`).
 */
export function LimitNotices({
  notices,
  onAction,
  className
}: {
  notices: LimitNotice[]
  onAction?: (target: NonNullable<LimitNotice['target']>) => void
  className?: string
}): React.JSX.Element | null {
  if (!notices.length) return null
  return (
    <div className={cn('rounded-md border border-divider', className)} role="status">
      {notices.map((n, i) => (
        <div
          key={`${n.when}-${i}`}
          className={cn(
            'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-[13px]',
            i > 0 && 'border-t border-divider'
          )}
        >
          <span className="w-[104px] shrink-0 text-[13px] text-muted">{n.when}</span>
          <span
            className={cn(
              'min-w-[220px] flex-1 text-[13.5px] leading-[1.6]',
              n.block ? 'text-ink' : 'text-ink-2'
            )}
          >
            {n.text}
          </span>
          {n.action && n.target && onAction ? (
            <button
              type="button"
              onClick={() => onAction(n.target!)}
              className="text-[13px] text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
            >
              {n.action}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
