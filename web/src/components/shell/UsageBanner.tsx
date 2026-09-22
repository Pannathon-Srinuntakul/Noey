import { X } from 'lucide-react'
import { useState } from 'react'
import { bannerKey, nearLimit, paymentFailedNotice } from '../../lib/planLadder'
import { useRouter } from '../../lib/router'
import { useUsageInfo } from '../../lib/usageInfo'
import { limitLabel, pctText, resetLine } from '../../lib/usageLimits'

const DISMISS_KEY = 'noey.usageBanner.dismissed'

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

function writeDismissed(key: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, key)
  } catch {
    // A private window without storage: the banner simply comes back next time.
  }
}

/**
 * "เตือนก่อนเต็ม" (docs/design/editor-limits.md §2): an accent strip under the
 * title bar once a quota window reaches 80%. Dismissing it hides it for THAT
 * window and reset only — the next window warns again.
 */
export function UsageBanner(): React.JSX.Element | null {
  const { usage } = useUsageInfo()
  const { navigate } = useRouter()
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)
  if (!usage || usage.unlimited) return null
  // A failed payment outranks a near-full window: the plan itself is at stake.
  if (usage.grace_until) {
    const n = paymentFailedNotice(usage.grace_until)
    return (
      <div
        role="status"
        className="mx-3 mt-2 flex flex-wrap items-center gap-3 rounded-md border border-error bg-error-tint px-3.5 py-[9px] md:mx-5"
      >
        <span className="text-[13.5px] text-error">{n.text}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => navigate({ name: 'settings' })}
          className="text-[13.5px] text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
        >
          {n.action}
        </button>
      </div>
    )
  }
  const hot = nearLimit(usage.limits)
  if (!hot) return null
  const key = bannerKey(hot)
  if (dismissed === key) return null

  return (
    <div
      role="status"
      className="mx-3 mt-2 flex flex-wrap items-center gap-3 rounded-md border border-[rgb(217_164_65_/_0.4)] bg-accent-tint px-3.5 py-[9px] md:mx-5"
    >
      <span className="text-[13.5px] tabular-nums text-accent-hover-text">
        {limitLabel(hot.key)} ใช้ไป {pctText(hot.used_pct)} · {resetLine(hot.key, hot.resets_at)}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => navigate({ name: 'settings' })}
        className="text-[13.5px] text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
      >
        ดูแผน
      </button>
      <button
        type="button"
        aria-label="ปิด"
        onClick={() => {
          writeDismissed(key)
          setDismissed(key)
        }}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[4px] text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)]"
      >
        <X size={13} />
      </button>
    </div>
  )
}
