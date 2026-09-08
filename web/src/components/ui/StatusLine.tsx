import { Check, Clock, Loader2, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/cn'

export type Status = 'ok' | 'working' | 'error' | 'idle'

export interface StatusLineProps {
  status: Status
  label: string
  className?: string
}

const STATUS_ICON: Record<Status, React.ComponentType<{ size?: number; className?: string }>> = {
  ok: Check,
  working: Loader2,
  error: TriangleAlert,
  idle: Clock
}

const STATUS_COLOR: Record<Status, string> = {
  ok: 'text-ok',
  working: 'text-accent',
  error: 'text-error',
  idle: 'text-muted'
}

/** Only these four statuses exist — no pill, no fill background. */
export function StatusLine({ status, label, className }: StatusLineProps): React.JSX.Element {
  const Icon = STATUS_ICON[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-[7px] text-sm font-semibold',
        STATUS_COLOR[status],
        className
      )}
    >
      <Icon size={14} className={status === 'working' ? 'animate-spin' : undefined} />
      {label}
    </span>
  )
}
