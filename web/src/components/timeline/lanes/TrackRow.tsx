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
  onLanePointerDown,
  children
}: {
  heightPx: number
  label: React.ReactNode
  laneClassName: string
  contentW: number
  onLanePointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center" style={{ height: heightPx, marginBottom: TRACK_GAP_PX }}>
      <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
        {label}
      </div>
      <div className={laneClassName} style={{ width: contentW }} onPointerDown={onLanePointerDown}>
        {children}
      </div>
    </div>
  )
}
