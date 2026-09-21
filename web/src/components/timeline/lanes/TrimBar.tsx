import type { TrimEdge } from '../../../lib/timelineMath'

/**
 * R3's ที่จับยืด–หด: a gold bar the full height of the block, 12px wide, on
 * the selected block. Every other block gets the same grip as an invisible
 * edge zone (8px, a third of a narrow block — constants.edgeZonePx) with the
 * resize cursor — any block's edge trims it, the way a
 * normal editor works, instead of select first, then trim (owner, 2026-09-22).
 */
export function TrimBar({
  edge,
  visible = true,
  zonePx = 8,
  onTrimDown
}: {
  edge: TrimEdge
  /** False: the invisible edge zone of a block that is not selected. */
  visible?: boolean
  /** The invisible zone's width (constants.edgeZonePx). */
  zonePx?: number
  onTrimDown: (e: React.PointerEvent, edge: TrimEdge) => void
}): React.JSX.Element {
  const side = edge === 'left' ? 'left-0 rounded-l-[5px]' : 'right-0 rounded-r-[5px]'
  if (!visible) {
    // z-10, UNDER the playhead's grab strip (z-20), where the gold handles
    // (z-30) sit above it. The playhead parks on scene boundaries all the time
    // — after a trim, at 0:00, on a caption jump — and with a zone on every
    // block, a zone on top would turn a press on the playhead into a trim of
    // whichever scene happens to end there.
    return (
      <span
        aria-hidden
        data-trim-handle
        onPointerDown={(e) => {
          if (e.button === 0) onTrimDown(e, edge)
        }}
        className={`absolute inset-y-0 z-10 cursor-ew-resize touch-none ${side}`}
        style={{ width: zonePx }}
      />
    )
  }
  return (
    <button
      type="button"
      data-trim-handle
      title={edge === 'left' ? 'ลากเพื่อปรับจุดเริ่ม' : 'ลากเพื่อปรับจุดจบ'}
      onPointerDown={(e) => onTrimDown(e, edge)}
      className={`absolute inset-y-0 z-30 flex w-[12px] cursor-ew-resize touch-none items-center justify-center bg-accent ${side}`}
    >
      <span className="block h-3 w-[2px] rounded bg-black/50" />
    </button>
  )
}
