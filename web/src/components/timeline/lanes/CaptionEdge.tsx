import type { CaptionChipSpan, TrimEdge } from '../../../lib/timelineMath'

/** Invisible 8px grab strip on a caption chip's edge. */
export function CaptionEdge({
  chip,
  edge,
  onDrag
}: {
  chip: CaptionChipSpan
  edge: TrimEdge
  onDrag: (chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-trim-handle
      title={edge === 'left' ? 'ลากเพื่อเลื่อนเวลาเริ่ม' : 'ลากเพื่อเลื่อนเวลาจบ'}
      aria-label={edge === 'left' ? 'ปรับเวลาเริ่มของท่อนนี้' : 'ปรับเวลาจบของท่อนนี้'}
      onPointerDown={(e) => onDrag(chip, edge, e)}
      className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none ${
        edge === 'left' ? 'left-0' : 'right-0'
      }`}
    />
  )
}
