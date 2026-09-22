import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { memo } from 'react'
import { bindTrimDrag, snapTrimToBeat, type TrimEdge } from '../../../lib/timelineMath'
import type { FilmstripStrip } from '../../../lib/useFilmstripStrips'
import { FilmstripCanvas } from '../../FilmstripCanvas'
import { HEADER_COL_PX, IMG_LANE_PX, edgeZonePx } from '../constants'
import type { TrimSnapContext, WorkingCut } from '../types'
import { TrimBar } from './TrimBar'

/** Grabbable width for a scene block that is drawn narrower than this. It is an
 * overlay, never the block's own width — see EditedCutBlock. */
const MIN_BLOCK_HIT_PX = 14

/**
 * Concatenated "edited" view of a scene: a cropped window of its source's full
 * filmstrip so scenes read as trimmed clips laid back-to-back, no gaps. The
 * whole block is draggable to reorder (R3: ลากตัวบล็อกเพื่อสลับลำดับ).
 *
 * Memoized, and every callback takes the cut or its id, so the lane hands all
 * blocks the same functions: trimming one scene renders that block and the
 * ones after it (their start moved), not the ones before.
 */
export const EditedCutBlock = memo(function EditedCutBlock({
  cut,
  selected,
  playOrder,
  strip,
  pending = false,
  sourceDurationSec,
  pxPerSec,
  onSelect,
  onChange,
  onTrim,
  onDragStart,
  onDragEnd,
  startOffsetSec = 0,
  getSnapContext
}: {
  cut: WorkingCut
  pending?: boolean
  selected: boolean
  playOrder: number
  strip: FilmstripStrip | null
  sourceDurationSec: number
  pxPerSec: number
  onSelect: (cut: WorkingCut) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  /** A trim-handle drag step: the cut as the drag found it, the edge, the
   * (snapped) patch, and the in-point before this step — the parent keeps
   * the left edge under the pointer. */
  onTrim?: (cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  /** This cut's start position on the output/edited timeline — trimming this
   * cut's edge only ever moves the boundary at startOffsetSec + durationSec. */
  startOffsetSec?: number
  /** The music's beats and whether to snap to them — asked once, when a trim
   * starts, and kept for the whole drag. Passing them as props rendered
   * every block whenever the music moved. */
  getSnapContext: () => TrimSnapContext
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cut.id
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined
  }
  const durationSec = Math.max(cut.out - cut.in, 0)
  // EXACT — the same clock as the ruler, the playhead, the caption chips, the
  // voiceover blocks and the beat ticks, all of which are positioned at
  // `t * pxPerSec`. A 24px floor used to be baked in here, and because the
  // blocks sit in a `flex` row with `shrink-0`, every inflated block SHIFTED
  // every block after it: press พอดีจอ on a 40-scene 2-minute project
  // (~8.7 px/s, so anything under 2.8 s hits the floor) and the lane ended up
  // over a hundred pixels right of the ruler mark it claimed to be under. You
  // then clicked the scene beneath the playhead and selected a different one
  // (2026-09-07). At MIN_PX_PER_SEC the floor covered six whole seconds.
  const widthPx = durationSec * pxPerSec
  // The floor comes back as an OVERHANGING hit target instead — the same
  // pattern the music block, the VO blocks and the caption chips already use,
  // so a very short scene stays grabbable without moving its neighbours.
  const hitPadPx = widthPx < MIN_BLOCK_HIT_PX ? MIN_BLOCK_HIT_PX : 0

  const maxOut = Math.max(sourceDurationSec, cut.out)

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge): void {
    onSelect(cut)
    const snap = getSnapContext()
    // The in-point as of the previous drag step — `cut` is frozen at drag start.
    let lastIn = cut.in
    // Only this cut's END lands on a new output-timeline position when trimmed
    // (its start is fixed by prior cuts' cumulative duration) — snap whichever
    // edge is being dragged so the resulting duration puts that end on-beat.
    const snappingOnChange = (patch: Partial<WorkingCut>): void => {
      const snapped = snapTrimToBeat({
        patch,
        cut,
        startOffsetSec,
        maxOut,
        ...snap
      })
      if (onTrim) onTrim(cut, edge, snapped, lastIn)
      else onChange(cut.id, snapped)
      if (snapped.in !== undefined) lastIn = snapped.in
    }
    bindTrimDrag({
      e,
      edge,
      pxPerSec,
      startIn: cut.in,
      startOut: cut.out,
      minIn: 0,
      maxOut,
      onChange: snappingOnChange,
      onDragStart,
      onDragEnd
    })
  }

  return (
    <li
      ref={setNodeRef}
      data-cut-block
      data-cut-id={cut.id}
      style={{ ...style, width: widthPx }}
      className="relative h-full shrink-0 list-none"
      {...attributes}
      {...listeners}
      // The selected block already wears a gold border; the global focus ring
      // drawn on top of it after a key press read as a second selection
      // (owner, 2026-09-22).
      data-focus-ring="none"
      // Selected on PRESS, like any editor — and before dnd-kit sees the
      // pointer, so a block picked up to reorder is the selected one. It was
      // on click, i.e. on release.
      onPointerDown={(e) => {
        if (e.button === 0) onSelect(cut)
        listeners?.onPointerDown?.(e)
      }}
    >
      {hitPadPx > 0 && (
        /* Overhangs its neighbours rather than widening the block, so a scene
           too narrow to hit stays clickable while the lane keeps lining up
           with the ruler. */
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 z-10 -translate-x-1/2 cursor-grab"
          style={{ width: hitPadPx }}
        />
      )}
      <div
        className={`relative h-full w-full cursor-grab overflow-hidden rounded-[5px] border bg-black active:cursor-grabbing ${
          selected ? 'border-accent' : 'border-border'
        }`}
      >
        {/* The block draws ONLY its own trimmed window — `sourceStartSec` is the
            cut's in-point, so there is no full-source strip offset behind a
            crop any more. A block that is offscreen draws nothing at all. */}
        <FilmstripCanvas
          strip={strip}
          pending={pending}
          sourceStartSec={cut.in}
          laneWidthPx={widthPx}
          heightPx={IMG_LANE_PX}
          laneLeftPx={HEADER_COL_PX + startOffsetSec * pxPerSec}
          pxPerSec={pxPerSec}
          opacity={0.6}
        />
        <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
          {playOrder}
        </span>
        {(selected || edgeZonePx(widthPx) > 0) && (
          <>
            <TrimBar
              edge="left"
              visible={selected}
              zonePx={edgeZonePx(widthPx)}
              onTrimDown={onTrimDown}
            />
            <TrimBar
              edge="right"
              visible={selected}
              zonePx={edgeZonePx(widthPx)}
              onTrimDown={onTrimDown}
            />
          </>
        )}
      </div>
    </li>
  )
})
