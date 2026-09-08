import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TooltipProps {
  content: ReactNode
  /** Rendered in muted monospace after the content, e.g. "⌘S". */
  shortcutKey?: string
  side?: 'top' | 'bottom'
  children: ReactNode
  className?: string
}

/** Never let this be the only place a control is named — it supplements a
 * visible label or `aria-label`, per HANDOFF §3 Tooltip. */
export function Tooltip({
  content,
  shortcutKey,
  side = 'top',
  children,
  className
}: TooltipProps): React.JSX.Element {
  return (
    <span className={cn('group/tooltip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          // Wraps, and appears on TAP as well as hover. A touch device has no
          // hover, and a disabled control cannot take focus, so every
          // "why is this greyed out" reason was unreachable on a phone. The
          // width cap keeps a Thai sentence from painting past the screen edge
          // — it used to be one ~200px nowrap line centred on a control that
          // may sit 20px from the edge.
          'pointer-events-none absolute left-1/2 z-50 w-max max-w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-[rgb(243_242_242_/_0.2)] bg-surface px-2.5 py-[7px] text-[13px] text-ink opacity-0 transition-opacity duration-state ease-out group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 group-active/tooltip:opacity-100',
          side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
        )}
      >
        {content}
        {shortcutKey ? <span className="ml-2 font-mono text-muted">{shortcutKey}</span> : null}
      </span>
    </span>
  )
}
