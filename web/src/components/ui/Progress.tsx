import { Fragment } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface ProgressProps {
  /** Step labels in order. Callers derive these from `lib/projectFlow.ts`
   * (`progressStagesFor` + `SHORT_STEP_LABELS`) — never hardcode a fixed step
   * count: a dub run is 4 stages, 6 while a voiceover render is actually
   * running, talking_head 4, highlight 3. */
  steps: string[]
  currentIndex: number
  percent: number
  etaMinutes?: number
  /** Work is live right now — draws the spinner next to the percent. */
  busy?: boolean
  className?: string
}

export function Progress({
  steps,
  currentIndex,
  percent,
  etaMinutes,
  busy = false,
  className
}: ProgressProps): React.JSX.Element {
  return (
    <div className={className}>
      {/* Wraps below `sm`. Labels are shrink-0 + whitespace-nowrap and
          connectors have a 20px floor, so the rail has a hard min-content
          width — a 5-stage speech run is ~470px, against ~310px of card at
          390, and the overflow scrolled the whole page sideways. Wrapped, the
          connectors would draw stray dashes between rows, so they only appear
          once the row is a single line again. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Connectors are direct siblings of the labels so `flex-1` has room to
            grow — nesting each pair in its own span left them at a fixed 20px
            and bunched every step against the left edge. */}
        {steps.map((step, i) => {
          const done = i < currentIndex
          const current = i === currentIndex
          return (
            <Fragment key={step}>
              {i > 0 ? (
                <span
                  className={cn(
                    'hidden h-px min-w-[20px] flex-1 sm:block',
                    i <= currentIndex ? 'bg-accent' : 'bg-border-faint'
                  )}
                />
              ) : null}
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm',
                  current ? 'font-semibold text-accent' : 'text-muted'
                )}
              >
                {done ? <Check size={13} className="text-accent" /> : null}
                {step}
              </span>
            </Fragment>
          )
        })}
      </div>
      <div className="mt-4 h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
        <div
          className="h-1 rounded-[2px] bg-accent transition-[width] duration-panel ease-out"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      {/* The spinner is the only motion between stage transitions — the fill
          only animates when percent CHANGES, and stages are minutes apart. */}
      <p className="mt-3 flex items-center gap-1.5 text-[15px] tabular-nums text-ink-3">
        {busy ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" /> : null}
        {Math.round(percent)}%{etaMinutes != null ? ` · เหลืออีกประมาณ ${etaMinutes} นาที` : null}
      </p>
    </div>
  )
}
