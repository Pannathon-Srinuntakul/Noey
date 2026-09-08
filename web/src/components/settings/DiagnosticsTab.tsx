import { useCallback, useState } from 'react'
import { Copy, RotateCw, Trash2 } from 'lucide-react'
import { clearLogLines, recentLogLines } from '../../platform/misc'
import { wakeLockSupported } from '../../lib/wakeLock'
import { Button } from '../ui/Button'

/**
 * The activity log, readable on the device that has the problem.
 *
 * A phone has no console. When a render stops on a phone there are three
 * stories — the browser discarded the tab, the job threw, or the job stalled —
 * and they are indistinguishable from the outside. The log tells them apart,
 * but only if it can be READ where it happened, which is what this tab is for.
 *
 * How to read it (the whole reason the lines are shaped the way they are):
 *
 *   engine job start …            a render began
 *   engine … · proxy · 40%        heartbeat, at most one every 3s
 *   lifecycle hidden              the tab went to the background — iOS throttles
 *                                 a hidden tab to a stop; expected, not a bug
 *   lifecycle pagehide            the last thing iOS sends before suspending
 *   lifecycle boot                the page was RE-CREATED. A boot line between a
 *                                 job start and its end means the browser threw
 *                                 the tab away; nothing in the app does that.
 *   engine job end … FAILED       the job itself gave up, with the reason
 *
 * A gap between heartbeats with none of the above in it is a genuine stall.
 */
export function DiagnosticsTab(): React.JSX.Element {
  const [lines, setLines] = useState<string[]>(() => recentLogLines())
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => setLines(recentLogLines()), [])

  // Newest first: on a phone the interesting line is the last thing that
  // happened, and scrolling to the bottom of 400 lines to find it is a chore.
  const shown = [...lines].reverse()

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[15px] font-semibold text-ink">บันทึกการทำงาน</p>
        <p className="mt-1 text-sm leading-[1.6] text-muted">
          ใช้ตอนงานหยุดกลางคันแล้วไม่รู้สาเหตุ — คัดลอกแล้วส่งมาให้ดูได้เลย
          บันทึกนี้เก็บไว้ในเครื่องนี้เท่านั้น
        </p>
      </div>

      <div className="rounded-md border border-divider px-5 py-3.5 text-sm text-muted">
        <p>
          กันจอดับระหว่างเรนเดอร์:{' '}
          <span className="text-ink">
            {wakeLockSupported() ? 'ใช้ได้' : 'เบราว์เซอร์นี้ไม่รองรับ'}
          </span>
        </p>
        <p className="mt-1.5 leading-[1.6]">
          ระหว่างเรนเดอร์ ให้เปิดหน้านี้ค้างไว้ อย่าสลับไปแอปอื่นและอย่าล็อกหน้าจอ —
          เบราว์เซอร์บนมือถือจะหยุดงานที่ทำอยู่เมื่อแท็บถูกพักไว้
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="secondary" icon={<RotateCw size={16} />} onClick={refresh}>
          รีเฟรช
        </Button>
        <Button
          variant="secondary"
          icon={<Copy size={16} />}
          onClick={() => {
            void navigator.clipboard.writeText(lines.join('\n')).catch(() => undefined)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'คัดลอกแล้ว' : 'คัดลอกทั้งหมด'}
        </Button>
        <Button
          variant="ghost"
          icon={<Trash2 size={16} />}
          onClick={() => {
            clearLogLines()
            setLines([])
          }}
        >
          ล้างบันทึก
        </Button>
        <span className="ml-auto text-sm tabular-nums text-muted">{lines.length} บรรทัด</span>
      </div>

      {shown.length > 0 ? (
        // `break-all`: these lines carry a user-agent string and file paths,
        // neither of which has a space to break at on a phone.
        <div className="scroll-ghost max-h-[50dvh] overflow-y-auto rounded-md border border-divider bg-[rgb(243_242_242_/_0.03)] px-4 py-3">
          {shown.map((line, i) => (
            <p
              key={`${i}-${line.slice(0, 24)}`}
              className="break-all font-mono text-[12px] leading-[1.7] text-muted"
            >
              {line}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">ยังไม่มีบันทึก</p>
      )}
    </div>
  )
}
