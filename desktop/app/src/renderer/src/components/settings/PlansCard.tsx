import { cn } from '../../lib/cn'
import {
  canChangePlan,
  PLAN_FOOTER,
  PLAN_ROWS,
  planButtonLabel,
  planRank,
  priceText
} from '../../lib/planLadder'

/**
 * "แผน" (docs/design/editor-limits.md §5): every plan with its one-line
 * summary and price; the current one tinted with "ใช้อยู่", the others with a
 * text button — "เปลี่ยนเป็นแผนนี้" going up, "ลดมาแผนนี้" going down. Prices
 * come from `GET /billing/plans` (`prices`, satang by tier).
 */
export function PlansCard({
  current,
  prices,
  pendingPlan,
  onPick
}: {
  current: string
  prices: Record<string, number>
  pendingPlan: string | null
  onPick: (tier: string) => void
}): React.JSX.Element {
  const changeable = canChangePlan(current)
  const currentRank = planRank(current)
  return (
    <section id="plans" className="rounded-md border border-divider">
      <p className="px-4 pb-1 pt-4 text-item font-semibold text-ink">แผน</p>
      {PLAN_ROWS.map((p) => {
        const isCurrent = p.key === current
        const label = changeable ? planButtonLabel(current, p.key) : null
        return (
          <div
            key={p.key}
            className={cn(
              'flex items-center gap-3.5 border-b border-divider px-4 py-3.5',
              isCurrent && 'bg-[rgb(217_164_65_/_0.08)]'
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span
                className={cn('text-[14.5px] font-medium', isCurrent ? 'text-accent' : 'text-ink')}
              >
                {p.name}
              </span>
              <span className="text-[13px] text-muted">{p.sub}</span>
            </span>
            <span className="flex-1" />
            <span className="whitespace-nowrap text-sm tabular-nums text-ink-2">
              {p.key === 'free'
                ? priceText(0)
                : prices[p.key] != null
                  ? priceText(prices[p.key])
                  : '—'}
            </span>
            {isCurrent ? (
              <span className="w-[104px] text-right text-[13px] text-accent">ใช้อยู่</span>
            ) : pendingPlan === p.key ? (
              <span className="w-[104px] text-right text-[13px] text-muted">รอบบิลถัดไป</span>
            ) : label ? (
              <button
                type="button"
                onClick={() => onPick(p.key)}
                className={cn(
                  'w-[104px] text-right text-[13px] transition-colors duration-state ease-out hover:text-accent-hover-text',
                  planRank(p.key) > currentRank ? 'text-accent' : 'text-muted'
                )}
              >
                {label}
              </button>
            ) : (
              <span className="w-[104px]" />
            )}
          </div>
        )
      })}
      <p className="px-4 py-[13px] text-[13px] text-muted">
        {changeable ? PLAN_FOOTER : 'แผนนี้ผู้ดูแลตั้งให้ ติดต่อผู้ดูแลเพื่อเปลี่ยนแผน'}
      </p>
    </section>
  )
}
