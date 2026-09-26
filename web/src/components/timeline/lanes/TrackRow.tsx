import { HEADER_COL_PX, TRACK_GAP_PX, trackLabelCls } from '../constants'

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
      <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
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
