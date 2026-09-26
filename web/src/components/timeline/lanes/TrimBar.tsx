import type { TrimEdge } from '../../../lib/timelineMath'

/** Title text shared by both variants — the roll gesture is discoverable
 * from the handle itself, nowhere else. */
const ROLL_HINT = 'ค้าง ⌘/Ctrl แล้วลากเพื่อเลื่อนรอยตัดทั้งสองฉาก'

/** The painted bar's width. The grab area stays 12px (BAR_HIT_PX): a 12px
 * bar read as a block of its own, not the clip's edge (owner, 2026-09-27),
 * so like CapCut's brackets the paint is thin and the hit zone is not. */
const BAR_PX = 5
const BAR_HIT_PX = 12

/**
 * R3's ที่จับยืด–หด: a thin gold bracket the full height of the block, on
 * the selected block's edge, with a 12px grab zone behind it. Every other
 * block gets the same grip as an edge zone (8px, a third of a narrow block —
 * constants.edgeZonePx; wider on a touch pointer) with the resize cursor —
 * any block's edge trims it, the way a normal editor works, instead of
 * select first, then trim (owner, 2026-09-22). The zone's bar appears on
 * hover (CapCut users look for the white bars), so the parent's inner div
 * carries `group`.
 *
 * The selected block's handle is a `role=slider` on the scene's in- or
 * out-point, part of the lanes' roving focus: only the focused edge is in the
 * tab order, and focus reports up so Alt+←/→ know which edge to nudge.
 */
export function TrimBar({
  edge,
  visible = true,
  zonePx = 8,
  sceneNumber,
  min,
  max,
  value,
  focused = false,
  atLimit = false,
  cutId,
  onTrimDown,
  onFocusEdge
}: {
  edge: TrimEdge
  /** False: the edge zone of a block that is not selected. */
  visible?: boolean
  /** The invisible zone's width (constants.edgeZonePx). */
  zonePx?: number
  /** The scene's play-order number, for the accessible name. */
  sceneNumber?: number
  /** The edge's value range and current value in seconds (the slider's). */
  min?: number
  max?: number
  value?: number
  /** This edge holds the lanes' roving focus. */
  focused?: boolean
  /** The edge is pinned at the end of the footage — painted red (FCP). */
  atLimit?: boolean
  cutId?: string
  onTrimDown: (e: React.PointerEvent, edge: TrimEdge) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
}): React.JSX.Element {
  const side = edge === 'left' ? 'left-0 rounded-l-[5px]' : 'right-0 rounded-r-[5px]'
  const fill = atLimit ? 'bg-error' : 'bg-accent'
  const title = atLimit
    ? 'หมดฟุตเทจ'
    : `${edge === 'left' ? 'ลากเพื่อปรับจุดเริ่ม' : 'ลากเพื่อปรับจุดจบ'} · ${ROLL_HINT}`
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
        title={title}
        onPointerDown={(e) => {
          if (e.button === 0) onTrimDown(e, edge)
        }}
        className={`absolute inset-y-0 z-10 cursor-ew-resize touch-none ${side}`}
        style={{ width: zonePx }}
      >
        {/* The hover-revealed bar, clipped by the block to whatever the zone
            allows on a narrow block. */}
        <span
          className={`absolute inset-y-0 block opacity-0 transition-opacity duration-state group-hover:opacity-70 ${fill} ${side}`}
          style={{ width: BAR_PX }}
        />
      </span>
    )
  }
  const label =
    sceneNumber !== undefined
      ? `${edge === 'left' ? 'จุดเริ่มของฉาก' : 'จุดจบของฉาก'} ${sceneNumber}`
      : edge === 'left'
        ? 'จุดเริ่มของฉาก'
        : 'จุดจบของฉาก'
  return (
    <button
      type="button"
      data-trim-handle
      role="slider"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={value !== undefined ? `${value.toFixed(2)} วินาที` : undefined}
      // Roving: the lanes are one Tab stop; ←/→ inside stay the frame step.
      tabIndex={focused ? 0 : -1}
      title={title}
      onPointerDown={(e) => onTrimDown(e, edge)}
      onFocus={() => {
        if (cutId !== undefined) onFocusEdge?.(cutId, edge)
      }}
      onBlur={() => {
        if (cutId !== undefined) onFocusEdge?.(cutId, null)
      }}
      // The button is the grab zone; only the inner bracket is painted, so
      // the footage shows right up to the edge.
      className={`absolute inset-y-0 z-30 cursor-ew-resize touch-none ${side}`}
      style={{ width: BAR_HIT_PX }}
    >
      <span
        className={`absolute inset-y-0 flex items-center justify-center ${fill} ${side}`}
        style={{ width: BAR_PX }}
      >
        <span className="block h-3 w-px rounded bg-black/40" />
      </span>
    </button>
  )
}
