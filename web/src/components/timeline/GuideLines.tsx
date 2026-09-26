import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { RefObject } from 'react'
import { fmtTimeTenths } from '../../lib/timelineMath'
import type { SnapKind } from '../../lib/timelineSnap'
import { HEADER_COL_PX, RULER_PX } from './constants'

export interface GuideLinesHandle {
  /** Draw the snap guide at `sec` (output or source clock — whichever the
   * lane is dragging on), or hide it with null. */
  setSnap(sec: number | null, kind?: SnapKind): void
  /** Draw the skimmer at `sec` with its time chip, or hide it with null. */
  setSkim(sec: number | null, label?: string): void
}

/**
 * Two full-height lines over the timeline content, painted imperatively —
 * the same pattern as paintTime: a drag frame writes `transform` + `display`
 * straight to the DOM and React never hears about it.
 *
 * - the snap guide: 2 px accent with a triangle head in the ruler row,
 *   shown while a drag is within snap tolerance of a target;
 * - the skimmer: 1 px hairline with a time chip, following the pointer while
 *   hover-skim is on (FCP skimmer / CapCut preview axis).
 *
 * z-[36]: above the lanes and the playhead's line copy (z-[35]) and below
 * the sticky track labels (z-40), so the guide is never hidden under a block
 * yet still scrolls under the label column. No transition — the line must
 * be where the pointer is on this very frame — which also satisfies
 * prefers-reduced-motion for free.
 */
export const GuideLines = forwardRef<
  GuideLinesHandle,
  {
    /** Touch-scrub padding before t=0 (the viewport hook's leadPx). */
    leadPx: number
    /** The current zoom, read at paint time — a drag outlives a render. */
    pxPerSecRef: RefObject<number>
  }
>(function GuideLines({ leadPx, pxPerSecRef }, ref) {
  const snapRef = useRef<HTMLDivElement | null>(null)
  const skimRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLSpanElement | null>(null)
  const leadRef = useRef(leadPx)
  leadRef.current = leadPx

  useImperativeHandle(
    ref,
    () => ({
      setSnap(sec, kind) {
        const el = snapRef.current
        if (!el) return
        if (sec === null || !Number.isFinite(sec)) {
          if (el.style.display !== 'none') el.style.display = 'none'
          return
        }
        const x = leadRef.current + HEADER_COL_PX + sec * (pxPerSecRef.current ?? 0)
        el.style.transform = `translateX(${x}px)`
        if (kind) el.dataset.kind = kind
        else delete el.dataset.kind
        if (el.style.display !== 'block') el.style.display = 'block'
      },
      setSkim(sec, label) {
        const el = skimRef.current
        if (!el) return
        if (sec === null || !Number.isFinite(sec)) {
          if (el.style.display !== 'none') el.style.display = 'none'
          return
        }
        const x = leadRef.current + HEADER_COL_PX + sec * (pxPerSecRef.current ?? 0)
        el.style.transform = `translateX(${x}px)`
        const text = label ?? fmtTimeTenths(sec)
        if (chipRef.current && chipRef.current.textContent !== text) {
          chipRef.current.textContent = text
        }
        if (el.style.display !== 'block') el.style.display = 'block'
      }
    }),
    [pxPerSecRef]
  )

  return (
    <>
      <div
        ref={snapRef}
        aria-hidden
        data-snap-guide
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-[36] will-change-transform"
        style={{ display: 'none', transition: 'none' }}
      >
        <span className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-accent" />
        {/* The triangle head in the ruler row, pointing at the target. */}
        <span
          className="absolute left-0 -translate-x-1/2 border-x-[6px] border-t-[6px] border-x-transparent border-t-accent"
          style={{ top: Math.max(0, RULER_PX - 8) }}
        />
      </div>
      <div
        ref={skimRef}
        aria-hidden
        data-skim-line
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-[36] will-change-transform"
        style={{ display: 'none', transition: 'none' }}
      >
        <span className="absolute inset-y-0 left-0 w-px bg-ink-3" />
        <span
          ref={chipRef}
          className="absolute top-0 left-1 rounded-[3px] bg-surface px-1 text-[13px] leading-[18px] tabular-nums whitespace-nowrap text-ink-3"
        />
      </div>
    </>
  )
})
