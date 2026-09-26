import type { CaptionChipSpan, TrimEdge } from '../../../lib/timelineMath'

/** Invisible 8px grab strip on a caption chip's edge — a slider on the
 * line's start or end, in seconds on the edited clock. */
export function CaptionEdge({
  chip,
  edge,
  onDrag
}: {
  chip: CaptionChipSpan
  edge: TrimEdge
  onDrag: (chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent) => void
}): React.JSX.Element {
  const value = edge === 'left' ? chip.outStart : chip.outStart + chip.durationSec
  return (
    <button
      type="button"
      data-trim-handle
      role="slider"
      aria-orientation="horizontal"
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(2)} วินาที`}
      tabIndex={-1}
      title={edge === 'left' ? 'ลากเพื่อเลื่อนเวลาเริ่ม' : 'ลากเพื่อเลื่อนเวลาจบ'}
      aria-label={edge === 'left' ? 'ปรับเวลาเริ่มของท่อนนี้' : 'ปรับเวลาจบของท่อนนี้'}
      onPointerDown={(e) => onDrag(chip, edge, e)}
      className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none ${
        edge === 'left' ? 'left-0' : 'right-0'
      }`}
    />
  )
}
