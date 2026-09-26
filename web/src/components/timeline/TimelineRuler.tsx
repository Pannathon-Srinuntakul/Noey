import { memo } from 'react'
import { fmtTime, rulerTicks } from '../../lib/timelineMath'

/** Shared time ruler — labels, major + minor ticks, the I/O range band;
 * dragging it moves the playhead, hovering it skims. Memoized: it redraws
 * for a zoom, a new length or a range change, not for a seek. */
export const TimelineRuler = memo(function TimelineRuler({
  durationSec,
  pxPerSec,
  widthPx,
  heightPx,
  leadPx = 0,
  coarse = false,
  range = null,
  onPointerDown,
  onHover
}: {
  durationSec: number
  pxPerSec: number
  widthPx: number
  /** Row height; RULER_PX on desktop, ≥ 28 on touch (the viewport hook
   * passes it). Without one the row fills its parent. */
  heightPx?: number
  /** Touch-scrub padding before t=0 (the viewport hook's leadPx). */
  leadPx?: number
  /** Touch: a taller hit target (min 28 px). */
  coarse?: boolean
  /** The I/O range on this clock, drawn as a translucent band with caps. */
  range?: { inSec: number; outSec: number } | null
  onPointerDown: (e: React.PointerEvent) => void
  /** Pointer x over the ruler (null when it leaves) — the editor turns it
   * into the skimmer + hover time chip. */
  onHover?: (clientX: number | null) => void
}): React.JSX.Element {
  const { majors, minors } = rulerTicks(pxPerSec, durationSec)
  const x = (t: number): number => leadPx + t * pxPerSec
  const minHeight = coarse ? 28 : undefined
  return (
    <div
      // Crosshair, matching the zoom editor's band — one gesture (put the
      // playhead here) should not look like two different tools.
      className="relative h-full shrink-0 cursor-crosshair border-b border-divider"
      style={{ width: widthPx + leadPx, height: heightPx, minHeight }}
      onPointerDown={onPointerDown}
      // Hover skim is a mouse / pen thing: a finger on the ruler is a scrub,
      // and on touch `pointermove` only fires while it is down and
      // `pointerleave` on the lift, so neither means "hovering here".
      onPointerMove={
        onHover
          ? (e) => {
              if (e.pointerType === 'touch') return
              onHover(e.clientX)
            }
          : undefined
      }
      onPointerLeave={
        onHover
          ? (e) => {
              if (e.pointerType === 'touch') return
              onHover(null)
            }
          : undefined
      }
      title="ลากไม้บรรทัดเพื่อเลื่อนหัวเล่น"
    >
      {/* The I/O range: a band the playhead can loop in and Shift+Delete
          removes, with a cap at each end so its edges are grabbable by eye. */}
      {range && range.outSec > range.inSec ? (
        <div
          aria-hidden
          data-range-band
          className="absolute inset-y-0 bg-accent-tint"
          style={{ left: x(range.inSec), width: (range.outSec - range.inSec) * pxPerSec }}
        >
          <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
          <span className="absolute inset-y-0 right-0 w-0.5 bg-accent" />
          <span className="absolute top-0 left-0 h-1.5 w-1.5 bg-accent" />
          <span className="absolute top-0 right-0 h-1.5 w-1.5 bg-accent" />
        </div>
      ) : null}
      {/* A label reads as belonging to the tick it ENDS at, so it sits just
          before its tick; t=0 has no tick and hugs the left edge (R3). */}
      {majors.map((t) => (
        <span
          key={t}
          className="absolute top-0.5 text-[13px] leading-none tabular-nums text-ink-3"
          style={
            t === 0 ? { left: x(0) } : { left: x(t), transform: 'translateX(calc(-100% - 4px))' }
          }
        >
          {fmtTime(t)}
        </span>
      ))}
      {majors.map((t) =>
        t === 0 ? null : (
          <span
            key={`M${t}`}
            className="absolute bottom-0 h-1.5 w-px bg-border"
            style={{ left: x(t) }}
          />
        )
      )}
      {/* Minor ticks: something to aim at between the labels. */}
      {minors.map((t) => (
        <span
          key={`m${t}`}
          className="absolute bottom-0 h-1 w-px bg-border-faint"
          style={{ left: x(t) }}
        />
      ))}
    </div>
  )
})
