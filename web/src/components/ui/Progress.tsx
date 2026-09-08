import { Fragment } from 'react'
import { Check } from 'lucide-react'
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
  className?: string
}

export function Progress({
  steps,
  currentIndex,
  percent,
  etaMinutes,
  className
}: ProgressProps): React.JSX.Element {
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
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
                    'h-px min-w-[20px] flex-1',
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
      <p className="mt-3 text-[15px] tabular-nums text-ink-3">
        {Math.round(percent)}%{etaMinutes != null ? ` · เหลืออีกประมาณ ${etaMinutes} นาที` : null}
      </p>
    </div>
  )
}
