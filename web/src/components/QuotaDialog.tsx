import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { formatBaht, limitLabel, whenBack, type LimitKey } from '../lib/usageLimits'

/**
 * "โควตารอบนี้หมดแล้ว" (docs/design/editor-limits.md §3) — shown when start is
 * pressed and the plan cannot cover the run. Nothing has uploaded yet.
 *
 * With a top-up balance that covers it, the primary action continues on the
 * balance; without one it goes to the usage settings, where the balance is
 * topped up. The body says what still works meanwhile: editing and
 * re-rendering never touch the limits.
 */
export function QuotaDialog({
  open,
  limitKey,
  resetsAt,
  walletSatang,
  onClose,
  onUseWallet,
  onAddQuota
}: {
  open: boolean
  limitKey: LimitKey | null
  resetsAt: string | null
  /** What the balance would pay; null when it cannot cover the run. */
  walletSatang: number | null
  onClose: () => void
  onUseWallet: () => void
  onAddQuota: () => void
}): React.JSX.Element | null {
  if (!open) return null
  const back = whenBack(resetsAt)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="โควตารอบนี้หมดแล้ว"
      subtitle={limitKey ? `${limitLabel(limitKey)}เหลือไม่พอสำหรับงานนี้` : undefined}
      width={560}
      footerActions={
        <>
          <Button variant="secondary" onClick={onClose}>
            เข้าใจแล้ว
          </Button>
          {walletSatang !== null ? (
            <Button variant="primary" onClick={onUseWallet}>
              ใช้ยอดเงินคงเหลือ {formatBaht(walletSatang)}
            </Button>
          ) : (
            <Button variant="primary" onClick={onAddQuota}>
              เพิ่มโควตา
            </Button>
          )}
        </>
      }
    >
      <p className="text-[15px] leading-[1.7] text-ink-2">
        {back ? `กลับมาเริ่มงานใหม่ได้${back.startsWith('อีก') ? '' : ' '}${back} · ` : ''}
        ระหว่างนี้ยังแก้ไทม์ไลน์และเรนเดอร์คลิปที่ตัดไว้แล้วได้
      </p>
    </Dialog>
  )
}
