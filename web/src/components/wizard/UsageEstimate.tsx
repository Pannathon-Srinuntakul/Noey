import { Gauge } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  estimateBlockLine,
  formatBaht,
  runCostLine,
  type UsageEstimate as Estimate
} from '../../lib/usageLimits'
import { Checkbox } from '../ui/Checkbox'

/**
 * What a run costs, said before the user commits to it.
 *
 * The price is a PERCENTAGE of the quota it will be charged against:
 * "งานนี้ใช้ประมาณ 5% ของโควตารายเดือน". That line is the honest half of the
 * whole model — without it a percentage meter cannot answer "how many more
 * runs do I have", and a person only learns what a job cost by watching the
 * meter fall afterwards. It comes from `POST /usage/estimate`; when the
 * estimate is unavailable this says NOTHING rather than guessing.
 *
 * Under it, when the window may not last, what happens then (a run is charged
 * as it goes, so it starts, pauses and resumes — the percent line went with
 * the reservation it described, owner 2026-09-26), and the consent checkbox
 * the start button honours when the top-up balance could carry it.
 */
export function UsageEstimateLine({
  estimate,
  loading,
  allowWallet,
  onAllowWallet,
  className
}: {
  estimate: Estimate | null
  loading: boolean
  allowWallet: boolean
  onAllowWallet: (allow: boolean) => void
  className?: string
}): React.JSX.Element | null {
  // Nothing is shown while the check runs: a "กำลังประเมิน…" line that
  // usually resolves to nothing at all is a flicker, not information.
  if (loading || !estimate || estimate.unlimited) return null
  const cost = runCostLine(estimate)
  const block = estimateBlockLine(estimate)
  if (!cost && !block) return null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {cost ? (
        <p className="flex items-start gap-2 text-[13px] leading-[1.6] tabular-nums text-ink-2">
          <Gauge size={15} className="mt-[3px] shrink-0" />
          <span>{cost}</span>
        </p>
      ) : null}
      {block ? (
        <p
          className={cn(
            'flex items-start gap-2 text-[13px] leading-[1.6] tabular-nums',
            estimate.fits === 'none' ? 'text-error' : 'text-accent'
          )}
        >
          {/* The icon is on the cost line when there is one — two of them
              stacked reads as two unrelated warnings. */}
          {!cost ? <Gauge size={15} className="mt-[3px] shrink-0" /> : null}
          <span className={!cost ? '' : 'pl-[23px]'}>{block}</span>
        </p>
      ) : null}
      {estimate.fits === 'wallet' ? (
        <Checkbox
          checked={allowWallet}
          onChange={onAllowWallet}
          label={`ใช้ยอดเงินคงเหลือ (ประมาณ ${formatBaht(estimate.wallet_satang)}) ทำงานนี้`}
        />
      ) : null}
    </div>
  )
}
