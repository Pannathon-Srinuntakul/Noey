import { Gauge } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  estimateBlockLine,
  formatBaht,
  type UsageEstimate as Estimate
} from '../../lib/usageLimits'
import { Checkbox } from '../ui/Checkbox'

/**
 * The quota note under the file list and above the start button. Silent when
 * the plan covers the run — a run is charged as it goes, so there is no
 * number to show up front (the percent line went with the reservation, owner
 * 2026-09-26). When the window may not last it says what happens then, and
 * when the top-up balance could carry it, offers the consent checkbox the
 * start button honours.
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
  const block = estimateBlockLine(estimate)
  if (!block) return null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p
        className={cn(
          'flex items-start gap-2 text-[13px] leading-[1.6] tabular-nums',
          estimate.fits === 'none' ? 'text-error' : 'text-accent'
        )}
      >
        <Gauge size={15} className="mt-[3px] shrink-0" />
        <span>{block}</span>
      </p>
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
