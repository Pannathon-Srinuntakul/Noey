import { cn } from '../../lib/cn'
import {
  BETA_BADGE,
  BETA_STRIP_TEXT,
  betaPricing,
  canChangePlan,
  FOOTAGE_NOTE,
  fullPriceAfterBeta,
  PLAN_ROWS,
  planButtonLabel,
  planFooter,
  planRank,
  priceText,
  QUOTA_NOTE
} from '../../lib/planLadder'

/**
 * "แผน" (docs/design/editor-limits.md §5): every plan with its one-line
 * summary and price; the current one tinted with "ใช้อยู่", the others with a
 * text button — "เปลี่ยนเป็นแผนนี้" going up, "ลดมาแผนนี้" going down. Prices
 * come from `GET /billing/plans` (`prices`, satang by tier).
 *
 * While the beta discount runs (`lib/planLadder.ts BETA_PRICE_ENDS_AT`) those
 * prices ARE the discounted ones — the strike-through beside each is the full
 * price, kept on the same line so no row grows taller and the table does not
 * shift on the day the discount ends and the strike-through disappears.
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
  const beta = betaPricing()
  return (
    <section id="plans" className="rounded-md border border-divider">
      <p className="px-4 pb-1 pt-4 text-item font-semibold text-ink">แผน</p>
      {beta ? (
        <div className="mx-4 mb-3 mt-2 flex flex-wrap items-center gap-2.5 rounded-sm border border-[rgb(217_164_65_/_0.4)] bg-accent-tint px-3 py-2">
          <span className="inline-flex h-[20px] items-center rounded-[4px] border border-[rgb(217_164_65_/_0.55)] px-1.5 text-[12px] text-accent">
            {BETA_BADGE}
          </span>
          <span className="flex-1 text-[13px] leading-[1.6] text-accent-hover-text">
            {BETA_STRIP_TEXT}
          </span>
        </div>
      ) : null}
      {PLAN_ROWS.map((p) => {
        const isCurrent = p.key === current
        const label = changeable ? planButtonLabel(current, p.key) : null
        // Only struck through when the row has a live price to compare it to.
        const full = prices[p.key] != null ? fullPriceAfterBeta(p.key) : null
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
            <span className="flex items-baseline gap-1.5 whitespace-nowrap text-sm tabular-nums text-ink-2">
              {full !== null ? (
                <span className="text-[13px] text-muted line-through">{priceText(full)}</span>
              ) : null}
              <span>
                {p.key === 'free'
                  ? priceText(0)
                  : prices[p.key] != null
                    ? priceText(prices[p.key])
                    : '—'}
              </span>
            </span>
            {isCurrent ? (
              <span className="w-[104px] text-right text-[13px] text-accent">ใช้อยู่</span>
            ) : pendingPlan === p.key ? (
              // Free is a credit spent once, never a cycle — a pending move to
              // it is a switch date, and must not read as "billed next cycle".
              <span className="w-[104px] text-right text-[13px] text-muted">
                {p.key === 'free' ? 'เมื่อสิ้นรอบบิล' : 'รอบบิลถัดไป'}
              </span>
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
      <div className="px-4 py-[13px] text-[13px] leading-[1.6] text-muted">
        {/* No clip count here (owner, 2026-10-01): it depends on the mode and
            the raw clip's length, which only the website's pricing calculator
            lets the reader set. */}
        <p>{QUOTA_NOTE}</p>
        <p className="mt-1">{FOOTAGE_NOTE}</p>
        <p className="mt-1">
          {changeable ? planFooter() : 'แผนนี้ผู้ดูแลตั้งให้ ติดต่อผู้ดูแลเพื่อเปลี่ยนแผน'}
        </p>
      </div>
    </section>
  )
}
