import { useState } from 'react'
import type { Wallet } from '../../lib/api'
import { cn } from '../../lib/cn'
import {
  formatBaht,
  formatPack,
  LEDGER_LABELS,
  METHOD_LABELS,
  orderedMethods,
  shortDate
} from '../../lib/usageLimits'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Segmented } from '../ui/Segmented'

/**
 * The top-up balance (plan §6 "extra usage"): what is left in baht, when the
 * oldest money expires, the packs on offer, and the recent movements.
 *
 * Baht only — the balance is spent at a fixed baht rate per unit of work, and
 * the user never sees that unit. It is used only after the plan's limits run
 * out, and only when the user says so at that moment ("ใช้ยอดเงินคงเหลือ").
 */
export function WalletCard({
  wallet,
  onTopup,
  busy
}: {
  wallet: Wallet
  onTopup: (packSatang: number, method: string) => void
  /** A checkout is being opened. */
  busy: boolean
}): React.JSX.Element {
  const methods = orderedMethods(wallet.methods.length ? wallet.methods : ['promptpay', 'card'])
  const [pack, setPack] = useState<number | null>(wallet.packs[0] ?? null)
  const [method, setMethod] = useState<string>(methods[0] ?? 'promptpay')
  // Lots are listed soonest-expiring first by the server; show only the one
  // that matters for planning.
  const nextExpiry = wallet.lots.find((l) => l.remaining_satang > 0)?.expires_at ?? null
  const history = wallet.history.slice(0, 6)

  return (
    <section className="rounded-md border border-divider p-5">
      <p className="text-item font-semibold text-ink">ยอดเงินคงเหลือ</p>
      <p className="mt-1 text-sm leading-[1.6] text-muted">
        ใช้ต่อเมื่อโควตาของแผนหมด และระบบจะถามก่อนทุกครั้ง · ยอดที่เติมใช้ได้ 12 เดือน
      </p>

      <p className="mt-3.5 text-[26px] font-semibold leading-tight tabular-nums text-ink">
        เหลือ {formatBaht(wallet.balance_satang)}
      </p>
      <p className="mt-1 text-[13px] tabular-nums text-muted">
        {wallet.reserved_satang > 0
          ? `กันไว้ให้งานที่กำลังทำ ${formatBaht(wallet.reserved_satang)} · `
          : ''}
        {nextExpiry ? `ยอดที่เก่าที่สุดหมดอายุ ${shortDate(nextExpiry)}` : 'ยังไม่มียอดคงเหลือ'}
      </p>

      <div className="mt-4">
        <p className="text-sm text-ink-2">เติมเงิน</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {wallet.packs.map((p) => (
            <Chip key={p} dense selected={pack === p} onClick={() => setPack(p)}>
              {formatPack(p)}
            </Chip>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented
            ariaLabel="วิธีชำระเงิน"
            value={method}
            onChange={setMethod}
            options={methods.map((m) => ({ value: m, label: METHOD_LABELS[m] ?? m }))}
          />
          {pack === null ? (
            <Button variant="primary" disabled disabledReason="เลือกจำนวนเงินก่อน">
              เติมเงิน
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => onTopup(pack, method)}>
              เติม {formatPack(pack)}
            </Button>
          )}
        </div>
      </div>

      {history.length > 0 ? (
        <div className="mt-4 border-t border-divider pt-3.5">
          <p className="text-sm text-muted">รายการล่าสุด</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {history.map((h, i) => (
              <p
                key={`${h.created_at}-${i}`}
                className="flex justify-between gap-3 text-sm tabular-nums"
              >
                <span className="text-ink-2">
                  {LEDGER_LABELS[h.kind] ?? h.kind}
                  <span className="text-muted"> · {shortDate(h.created_at)}</span>
                </span>
                <span className={cn(h.amount_satang < 0 ? 'text-muted' : 'text-ink')}>
                  {h.amount_satang < 0 ? '−' : '+'}
                  {formatBaht(Math.abs(h.amount_satang))}
                </span>
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
