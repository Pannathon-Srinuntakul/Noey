import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface ToastProps {
  text: string
  /**
   * Second line under `text` — the Component Kit's completion toast is a title
   * plus a detail line ("เรนเดอร์เสร็จแล้ว" / "<project> · 0:58"), which
   * callers had to flatten into one string while this did not exist.
   */
  detail?: string
  /** `ok` draws the kit's completion toast: green border + leading check. */
  variant?: 'default' | 'ok'
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
  /** Shows a live countdown digit next to the dismiss control. */
  showCountdown?: boolean
  durationMs?: number
  className?: string
}

/** Single fixed bottom-right slot — the design has exactly one toast at a
 * time system-wide, so the position is baked in rather than left to callers. */
export function Toast({
  text,
  detail,
  variant = 'default',
  actionLabel,
  onAction,
  onDismiss,
  showCountdown = false,
  durationMs = 10_000,
  className
}: ToastProps): React.JSX.Element {
  const [remaining, setRemaining] = useState(Math.ceil(durationMs / 1000))

  useEffect(() => {
    const dismissTimer = setTimeout(onDismiss, durationMs)
    const tick = showCountdown
      ? setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000)
      : undefined
    return () => {
      clearTimeout(dismissTimer)
      if (tick) clearInterval(tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per mount, not per prop churn
  }, [])

  return (
    <div
      className={cn(
        'fixed bottom-6 right-6 z-[110] flex items-center gap-3.5 rounded-md border bg-surface px-4.5 py-3.5 shadow-modal',
        variant === 'ok' ? 'border-[rgb(104_177_132_/_0.45)]' : 'border-border',
        className
      )}
    >
      {variant === 'ok' ? <Check size={17} className="shrink-0 text-ok" /> : null}
      <span className="min-w-0">
        <span className={cn('block text-[15px] text-ink', detail ? 'font-semibold' : undefined)}>
          {text}
        </span>
        {detail ? <span className="block text-sm text-muted">{detail}</span> : null}
      </span>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          className="text-sm font-semibold text-accent hover:text-accent-hover-text"
        >
          {actionLabel}
        </button>
      ) : null}
      {showCountdown ? <span className="text-sm tabular-nums text-muted">{remaining}</span> : null}
      <button type="button" onClick={onDismiss} className="text-sm text-muted hover:text-ink">
        ปิด
      </button>
    </div>
  )
}
