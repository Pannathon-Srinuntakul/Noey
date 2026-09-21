import { memo } from 'react'
import { fmtTime, rulerStepSec } from '../../lib/timelineMath'

/** Shared time ruler — labels + minor ticks; dragging it moves the playhead.
 * Memoized: it redraws for a zoom or a new length, not for a seek. */
export const TimelineRuler = memo(function TimelineRuler({
  durationSec,
  pxPerSec,
  widthPx,
  onPointerDown
}: {
  durationSec: number
  pxPerSec: number
  widthPx: number
  onPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element {
  const step = rulerStepSec(pxPerSec)
  const count = Math.max(1, Math.ceil(durationSec / step) + 1)
  const ticks = Array.from({ length: count }, (_, i) => i * step)
  return (
    <div
      // Crosshair, matching the zoom editor's band — one gesture (put the
      // playhead here) should not look like two different tools.
      className="relative h-full shrink-0 cursor-crosshair border-b border-divider"
      style={{ width: widthPx }}
      onPointerDown={onPointerDown}
      title="ลากไม้บรรทัดเพื่อเลื่อนหัวเล่น"
    >
      {/* A label reads as belonging to the tick it ENDS at, so it sits just
          before its tick; t=0 has no tick and hugs the left edge (R3). */}
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute top-0.5 text-[13px] leading-none tabular-nums text-ink-3"
          style={
            t === 0
              ? { left: 0 }
              : { left: t * pxPerSec, transform: 'translateX(calc(-100% - 4px))' }
          }
        >
          {fmtTime(t)}
        </span>
      ))}
      {ticks.map((t) =>
        t === 0 ? null : (
          <span
            key={`m${t}`}
            className="absolute bottom-0 h-1.5 w-px bg-border"
            style={{ left: t * pxPerSec }}
          />
        )
      )}
    </div>
  )
})
