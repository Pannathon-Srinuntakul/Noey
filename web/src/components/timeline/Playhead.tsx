import { memo } from 'react'
import type { RefObject } from 'react'
import { COARSE_PLAYHEAD_GRAB_PX } from './constants'

/**
 * The playhead: a positioned element over a static timeline, moved by the
 * editor writing `transform` on both layers (paintTime) — never by a render.
 * With stable props it renders once.
 *
 * The head is a `slider` for assistive tech: paintTime writes aria-valuenow /
 * aria-valuemax / aria-valuetext on `playheadRef`'s element, so the role lives
 * on that element and not on a child. ←/→ on the focused head are the global
 * frame step already.
 */
export const Playhead = memo(function Playhead({
  playheadRef,
  playheadLineRef,
  edgeHintRef,
  coarse = false,
  onGrabPointerDown
}: {
  playheadRef: RefObject<HTMLDivElement | null>
  playheadLineRef: RefObject<HTMLDivElement | null>
  /** The "playhead is off screen" pill: the viewport hook sets
   * `data-side="left" | "right"` (or removes it) from its follow test. */
  edgeHintRef?: RefObject<HTMLDivElement | null>
  /** Touch: a wider head and grab strip (the ~44 px target rule). */
  coarse?: boolean
  /** The same scrub the ruler starts. */
  onGrabPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element {
  const headW = coarse ? COARSE_PLAYHEAD_GRAB_PX : 18
  const stripW = coarse ? 16 : 8
  return (
    <>
      {/* playhead — a positioned element over a static timeline */}
      <div
        ref={playheadRef}
        role="slider"
        aria-label="หัวเล่น"
        aria-orientation="horizontal"
        aria-valuemin={0}
        tabIndex={0}
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 will-change-transform"
      >
        {/* The whole line is the handle, not just its head: an 8px
          grab strip runs the full height over a 2px visible rule,
          so you can catch the playhead wherever your eye is. */}
        <div
          onPointerDown={onGrabPointerDown}
          title="ลากเพื่อเลื่อนหัวเล่น"
          className="pointer-events-auto absolute top-0 bottom-0 -translate-x-1/2 cursor-ew-resize touch-none"
          style={{ width: stripW }}
        >
          <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink" />
        </div>
        <div
          onPointerDown={onGrabPointerDown}
          title="ลากเพื่อเลื่อนหัวเล่น"
          className="pointer-events-auto absolute top-0 h-3 -translate-x-1/2 cursor-ew-resize rounded-[2px_2px_4px_4px] bg-ink"
          style={{ width: headW }}
        />
      </div>
      {/* The rule again, on a layer above everything in the lanes
          but below the sticky track labels. The grab strip above
          stays UNDER the trim handles on purpose — a trim leaves
          the playhead parked on the edge it trimmed, and a strip on
          top would steal the handle — but its visible line used to
          vanish under the handles, a dragged block and the gold
          edges at every cut (live report 2026-09-21). This copy
          takes no input, so it can sit on top. */}
      <div
        ref={playheadLineRef}
        aria-hidden
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-[35] will-change-transform"
      >
        <span className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-ink" />
        <span
          className="absolute top-0 left-0 h-3 -translate-x-1/2 rounded-[2px_2px_4px_4px] bg-ink"
          style={{ width: headW }}
        />
      </div>
      {/* Off-screen hint (Premiere / Resolve draw this arrow): a pill stuck
          to whichever viewport edge the playhead went past. The row spans the
          whole scroll content; each pill is `position: sticky` so it parks at
          the viewport's edge while the lanes scroll. Hidden until the
          viewport hook sets data-side from its follow test. */}
      {edgeHintRef ? (
        <div
          ref={edgeHintRef}
          aria-hidden
          data-edge-hint
          className="group pointer-events-none absolute inset-x-0 top-1 z-[36] hidden h-0 data-[side=left]:flex data-[side=right]:flex"
        >
          <span className="sticky left-1 hidden h-6 items-center rounded-full border border-border bg-surface px-2 text-[13px] whitespace-nowrap text-ink-3 shadow-modal group-data-[side=left]:inline-flex">
            ◀ หัวเล่น
          </span>
          <span className="sticky right-1 ml-auto hidden h-6 items-center rounded-full border border-border bg-surface px-2 text-[13px] whitespace-nowrap text-ink-3 shadow-modal group-data-[side=right]:inline-flex">
            หัวเล่น ▶
          </span>
        </div>
      ) : null}
    </>
  )
})
