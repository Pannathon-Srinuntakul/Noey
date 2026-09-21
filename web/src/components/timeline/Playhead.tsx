import { memo } from 'react'
import type { RefObject } from 'react'

/**
 * The playhead: a positioned element over a static timeline, moved by the
 * editor writing `transform` on both layers (paintTime) — never by a render.
 * With stable props it renders once.
 */
export const Playhead = memo(function Playhead({
  playheadRef,
  playheadLineRef,
  onGrabPointerDown
}: {
  playheadRef: RefObject<HTMLDivElement | null>
  playheadLineRef: RefObject<HTMLDivElement | null>
  /** The same scrub the ruler starts. */
  onGrabPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element {
  return (
    <>
      {/* playhead — a positioned element over a static timeline */}
      <div
        ref={playheadRef}
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 will-change-transform"
      >
        {/* The whole line is the handle, not just its head: an 8px
          grab strip runs the full height over a 2px visible rule,
          so you can catch the playhead wherever your eye is. */}
        <div
          onPointerDown={onGrabPointerDown}
          title="ลากเพื่อเลื่อนหัวเล่น"
          className="pointer-events-auto absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize touch-none"
        >
          <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink" />
        </div>
        <div
          onPointerDown={onGrabPointerDown}
          title="ลากเพื่อเลื่อนหัวเล่น"
          className="pointer-events-auto absolute top-0 h-3 w-[18px] -translate-x-1/2 cursor-ew-resize rounded-[2px_2px_4px_4px] bg-ink"
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
        <span className="absolute top-0 left-0 h-3 w-[18px] -translate-x-1/2 rounded-[2px_2px_4px_4px] bg-ink" />
      </div>
    </>
  )
})
