import { Gauge } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  estimateBlockLine,
  estimateLine,
  formatBaht,
  type UsageEstimate as Estimate
} from '../../lib/usageLimits'
import { Checkbox } from '../ui/Checkbox'

/**
 * "ใช้ประมาณ 18% ของโควตารายสัปดาห์" under the file list and above the start
 * button. When the plan cannot cover the run it says so BEFORE anything
 * uploads; when the top-up balance can, it offers the consent checkbox the
 * start button then honours.
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
  if (loading) {
    return (
      <p className={cn('flex items-center gap-2 text-sm text-muted', className)}>
        <Gauge size={15} className="shrink-0" />
        กำลังประเมินการใช้งาน…
      </p>
    )
  }
  if (!estimate || estimate.unlimited) return null
  const line = estimateLine(estimate)
  const block = estimateBlockLine(estimate)
  if (!line) return null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p
        className={cn(
          'flex items-center gap-2 text-sm tabular-nums',
          estimate.fits === 'plan' ? 'text-ink-2' : 'text-accent'
        )}
      >
        <Gauge size={15} className="shrink-0" />
        {line}
      </p>
      {block ? (
        <p
          className={cn(
            'text-[13px] leading-[1.6] tabular-nums',
            estimate.fits === 'none' ? 'text-error' : 'text-muted'
          )}
        >
          {block}
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
