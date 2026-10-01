import { HEADER_COL_PX, TRACK_GAP_PX, trackLabelCls } from '../constants'

/**
 * The label cell also covers the gap UNDER it (a ground-coloured `::after`
 * TRACK_GAP_PX tall). Without that the name column had a hole between every
 * two tracks: whatever scrolls under the column — the playhead's line and its
 * grab strip, the snap guide, the skim line, marker and beat lines — showed
 * through those gaps as a small white square per track, parked over the
 * track names (owner report 2026-10-01, playhead scrolled just past the left
 * edge), and the playhead could still be grabbed there. The cover is part of
 * the label's own z-40 layer and takes no layout, so nothing moves and
 * nothing changes order against the clips.
 */
const LABEL_STYLE = {
  width: HEADER_COL_PX,
  '--track-gap': `${TRACK_GAP_PX}px`
} as React.CSSProperties
const LABEL_CLS = `${trackLabelCls} after:absolute after:inset-x-0 after:top-full after:h-(--track-gap) after:bg-ground`

/**
 * One track: the sticky name column and the lane beside it, sized to the
 * content width. Every lane is drawn in one of these, so they line up with
 * the ruler and with each other.
 *
 * Not memoized — its children are new every time its lane renders, and a
 * lane renders only when something in it changed.
 */
export function TrackRow({
  heightPx,
  label,
  laneClassName,
  contentW,
  leadPx = 0,
  role,
  ariaLabel,
  laneRef,
  onLanePointerDown,
  children
}: {
  heightPx: number
  label: React.ReactNode
  laneClassName: string
  contentW: number
  /** Room before the lane's axis: touch-scrub mode centres the playhead by
   * offsetting every axis by the same amount (the ruler, the lanes, the
   * guides). Applied as a margin so the lane's absolutely positioned blocks
   * move with it (padding would not move them) — so pass it here OR pad the
   * timeline content div, never both. */
  leadPx?: number
  /** ARIA role for the lane element (e.g. 'listbox' for a lane of options). */
  role?: string
  ariaLabel?: string
  /** The lane element, for a lane that reads its own geometry (marquee). */
  laneRef?: React.Ref<HTMLDivElement>
  onLanePointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center" style={{ height: heightPx, marginBottom: TRACK_GAP_PX }}>
      <div className={LABEL_CLS} style={LABEL_STYLE}>
        {label}
      </div>
      <div
        ref={laneRef}
        role={role}
        aria-label={ariaLabel}
        className={laneClassName}
        style={{ width: contentW, marginLeft: leadPx || undefined }}
        onPointerDown={onLanePointerDown}
      >
        {children}
      </div>
    </div>
  )
}
