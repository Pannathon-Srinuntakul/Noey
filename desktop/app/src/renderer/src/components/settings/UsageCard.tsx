import type { Usage } from '../../lib/api'
import { cn } from '../../lib/cn'
import {
  limitLabel,
  pctText,
  planName,
  queueNotice,
  resetLine,
  shortDate,
  storageText,
  usageTone
} from '../../lib/usageLimits'

/** Tone → classes. The value and its bar share one colour (design §1). */
const TONE_TEXT = { ink: 'text-ink', accent: 'text-accent', error: 'text-error' } as const
const TONE_BAR = { ink: 'bg-ink', accent: 'bg-accent', error: 'bg-error' } as const

/** 4px meter over the same track as the rest of settings. */
function MeterBar({ pct, tone }: { pct: number; tone: keyof typeof TONE_BAR }): React.JSX.Element {
  return (
    <div className="h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
      <div
        className={cn(
          'h-1 rounded-[2px] transition-[width] duration-panel ease-out',
          TONE_BAR[tone]
        )}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  )
}

/** One window or storage: name left, value right, bar, muted line under it. */
function MeterRow({
  name,
  value,
  pct,
  line
}: {
  name: string
  value: string
  pct: number
  line: string
}): React.JSX.Element {
  const tone = usageTone(pct)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-2">{name}</span>
        <span className={cn('text-sm font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</span>
      </div>
      <div className="mt-2">
        <MeterBar pct={pct} tone={tone} />
      </div>
      <p className="mt-1.5 text-[13px] tabular-nums text-muted">{line}</p>
    </div>
  )
}

/**
 * The usage card (docs/design/editor-limits.md §1): the plan, one meter per
 * limit the plan enforces, then storage. Percentages and reset times only —
 * `Usage` carries no token count and this card must never derive one.
 * Reset times are formatted in the viewer's own timezone.
 */
export function UsageCard({ usage }: { usage: Usage }): React.JSX.Element {
  const storagePct =
    usage.storage.quota_bytes > 0 ? (usage.storage.used_bytes / usage.storage.quota_bytes) * 100 : 0

  return (
    <section className="rounded-md border border-accent p-5">
      <div className="flex items-baseline gap-3">
        <p className="text-item font-semibold text-ink">แผน {planName(usage.plan)}</p>
        <span className="flex-1" />
        {usage.concurrency.max > 0 && !usage.unlimited ? (
          <span className="text-[13px] tabular-nums text-muted">
            ทำพร้อมกันได้ {usage.concurrency.max} งาน
          </span>
        ) : null}
        {/* Design §1: jumps to the plan list further down the same tab. */}
        <button
          type="button"
          onClick={() =>
            document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          className="text-[13.5px] text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
        >
          เปลี่ยนแผน
        </button>
      </div>

      {usage.grace_until ? (
        <p className="mt-2 text-sm leading-[1.6] text-error">
          ตัดบัตรไม่สำเร็จ ถ้ายังไม่สำเร็จจะกลับเป็นแผนฟรีวันที่ {shortDate(usage.grace_until)}
        </p>
      ) : usage.pending_plan ? (
        <p className="mt-2 text-sm leading-[1.6] text-muted">
          จะเปลี่ยนเป็นแผน {planName(usage.pending_plan.plan)}
          {usage.pending_plan.at ? ` วันที่ ${shortDate(usage.pending_plan.at)}` : ' ในรอบบิลถัดไป'}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        {usage.unlimited ? (
          <p className="text-sm text-muted">แผนนี้ไม่จำกัดโควตา</p>
        ) : (
          usage.limits.map((l) => (
            <MeterRow
              key={l.key}
              name={limitLabel(l.key)}
              value={`ใช้ไป ${pctText(l.used_pct)}`}
              pct={l.used_pct}
              line={resetLine(l.key, l.active ? l.resets_at : null)}
            />
          ))
        )}
        <MeterRow
          name="ที่เก็บไฟล์"
          value={storageText(usage.storage.used_bytes, usage.storage.quota_bytes)}
          pct={storagePct}
          line="ลบโปรเจกต์เก่าเพื่อคืนพื้นที่ได้"
        />
      </div>

      {usage.concurrency.queued > 0 ? (
        <p className="mt-4 text-[13px] leading-[1.6] text-muted">
          {queueNotice(usage.concurrency.max)} · รอคิวอยู่ {usage.concurrency.queued} งาน
        </p>
      ) : null}

      <p className="mt-4 border-t border-divider pt-3.5 text-[13px] leading-[1.6] text-muted">
        แก้ไทม์ไลน์ สลับช็อต และเรนเดอร์ซ้ำ ไม่กินโควตา
      </p>
    </section>
  )
}
