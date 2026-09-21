import { memo, useMemo } from 'react'
import type { CaptionLine } from '../../../lib/editorApi'
import type { CaptionChipSpan, TrimEdge } from '../../../lib/timelineMath'
import { CAPTION_LANE_PX } from '../constants'
import { CaptionEdge } from './CaptionEdge'
import { TrackRow } from './TrackRow'

/** คำบรรยาย — one chip per caption line on the edited clock; click to jump to
 * the line, drag an edge to retime it. */
export const CaptionLane = memo(function CaptionLane({
  captionLines,
  capSpans,
  captionCursorIdx,
  pxPerSec,
  contentW,
  onLaneBackgroundPointerDown,
  onDragEdge,
  onPickChip
}: {
  captionLines: CaptionLine[]
  capSpans: CaptionChipSpan[]
  /** The line the inspector is on. */
  captionCursorIdx: number
  pxPerSec: number
  contentW: number
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  onDragEdge: (chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent) => void
  /** A chip was clicked: its line's index. */
  onPickChip: (idx: number) => void
}): React.JSX.Element {
  // Each chip's line index, looked up instead of searched for per chip. The
  // first line with an id wins, as findIndex did.
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    captionLines.forEach((l, i) => {
      if (!m.has(l.id)) m.set(l.id, i)
    })
    return m
  }, [captionLines])
  return (
    <TrackRow
      heightPx={CAPTION_LANE_PX}
      label="คำบรรยาย"
      laneClassName="relative h-full"
      contentW={contentW}
      onLanePointerDown={onLaneBackgroundPointerDown}
    >
      {capSpans.map((chip) => {
        const idx = indexById.get(chip.id) ?? -1
        const isActive = idx === captionCursorIdx
        return (
          <div
            key={chip.id}
            data-cut-block
            onPointerDown={(e) => e.stopPropagation()}
            className={`absolute inset-y-0 rounded border transition-colors duration-state ${
              isActive
                ? 'border-accent bg-accent-nav'
                : 'border-border-faint bg-surface hover:border-border'
            }`}
            style={{
              left: chip.outStart * pxPerSec,
              width: Math.max(chip.durationSec * pxPerSec - 2, 16)
            }}
          >
            <button
              type="button"
              onClick={() => onPickChip(idx)}
              title={chip.text}
              className={`h-full w-full overflow-hidden px-2 text-left text-[13px] ${
                isActive ? 'text-ink' : 'text-ink-2'
              }`}
            >
              <span className="truncate">{chip.text}</span>
            </button>
            {/* Edge drags retime the line itself (R7). The
              handles are hit areas, not visible bars —
              the lane is 24px tall and a 12px bar would
              swallow the text. */}
            <CaptionEdge chip={chip} edge="left" onDrag={onDragEdge} />
            <CaptionEdge chip={chip} edge="right" onDrag={onDragEdge} />
          </div>
        )
      })}
    </TrackRow>
  )
})
