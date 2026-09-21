import { memo, useMemo, useRef } from 'react'
import type { EditTimelineSource } from '../../../lib/editorApi'
import {
  bindTrimDrag,
  clamp,
  sourceNeighborBoundsById,
  type TrimEdge
} from '../../../lib/timelineMath'
import type { FilmstripStrip, FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { FilmstripCanvas } from '../../FilmstripCanvas'
import { HEADER_COL_PX, IMG_LANE_PX, edgeZonePx, MIN_LANE_PX } from '../constants'
import type { WorkingCut } from '../types'
import { TrackRow } from './TrackRow'
import { TrimBar } from './TrimBar'

/** A lane with no scenes — one array, so its row can skip renders. */
const NO_CUTS: WorkingCut[] = []

/** Source view (จ) — one lane per file under the shared axis. */
export const SourceLanes = memo(function SourceLanes({
  sources,
  previewSource,
  strips,
  filmstripPending,
  cutsBySource,
  laneDurationById,
  playOrderMap,
  selectedId,
  pxPerSec,
  contentW,
  onSourceLanePointerDown,
  onSelectCut,
  onUpdateCut,
  onTrimCut,
  onBlockEditStart,
  onBlockEditEnd
}: {
  sources: EditTimelineSource[]
  /** The file the preview has loaded. */
  previewSource: string | null
  strips: FilmstripStripMap
  /** The thumbnail extraction is still running. */
  filmstripPending: boolean
  /** Each file's scenes, in play order. */
  cutsBySource: Map<string, WorkingCut[]>
  /** Each file's lane length — see the editor's getSourceDurationSec. */
  laneDurationById: Map<string, number>
  playOrderMap: Map<string, number>
  selectedId: string | null
  pxPerSec: number
  contentW: number
  onSourceLanePointerDown: (sourceId: string, e: React.PointerEvent) => void
  onSelectCut: (cut: WorkingCut) => void
  onUpdateCut: (id: string, patch: Partial<WorkingCut>) => void
  /** A trim-handle drag step — the editor applies it and shows the edge. */
  onTrimCut: (cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) => void
  onBlockEditStart: () => void
  onBlockEditEnd: () => void
}): React.JSX.Element {
  return (
    <>
      {sources.map((src) => (
        <TrackRow
          key={src.id}
          heightPx={IMG_LANE_PX}
          label={
            <span
              className={`truncate ${previewSource === src.id ? 'text-ink' : ''}`}
              title={src.id}
            >
              {src.id}
            </span>
          }
          laneClassName="relative h-full"
          contentW={contentW}
          onLanePointerDown={(e) => onSourceLanePointerDown(src.id, e)}
        >
          <SourceLaneRow
            laneDurationSec={laneDurationById.get(src.id) ?? 0}
            strip={strips[src.id] ?? null}
            pending={filmstripPending}
            cuts={cutsBySource.get(src.id) ?? NO_CUTS}
            playOrderMap={playOrderMap}
            selectedId={selectedId}
            pxPerSec={pxPerSec}
            isActive={previewSource === src.id}
            onSelect={onSelectCut}
            onChange={onUpdateCut}
            onTrim={onTrimCut}
            onDragStart={onBlockEditStart}
            onDragEnd={onBlockEditEnd}
          />
        </TrackRow>
      ))}
    </>
  )
})

const SourceLaneRow = memo(function SourceLaneRow({
  laneDurationSec,
  strip,
  pending = false,
  cuts,
  playOrderMap,
  selectedId,
  pxPerSec,
  isActive,
  onSelect,
  onChange,
  onTrim,
  onDragStart,
  onDragEnd
}: {
  laneDurationSec: number
  strip: FilmstripStrip | null
  pending?: boolean
  cuts: WorkingCut[]
  playOrderMap: Map<string, number>
  selectedId: string | null
  pxPerSec: number
  isActive: boolean
  onSelect: (c: WorkingCut) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onTrim: (cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) => void
  onDragStart: () => void
  onDragEnd: () => void
}): React.JSX.Element {
  const width = Math.max(laneDurationSec * pxPerSec, MIN_LANE_PX)
  // Every block's neighbours from one sort of the lane, not one sort per block.
  const bounds = useMemo(
    () => sourceNeighborBoundsById(cuts, laneDurationSec),
    [cuts, laneDurationSec]
  )

  return (
    <div
      className={`relative h-full overflow-hidden rounded-md border bg-surface ${
        isActive ? 'border-border-strong' : 'border-border-faint'
      }`}
      style={{ width }}
    >
      <FilmstripCanvas
        strip={strip}
        pending={pending}
        sourceStartSec={0}
        laneWidthPx={width}
        heightPx={IMG_LANE_PX}
        laneLeftPx={HEADER_COL_PX}
        pxPerSec={pxPerSec}
        opacity={0.4}
      />
      {cuts.map((c) => (
        <SourceCutBlock
          key={c.id}
          cut={c}
          minIn={bounds.get(c.id)?.minIn ?? 0}
          maxOut={bounds.get(c.id)?.maxOut ?? laneDurationSec}
          selected={c.id === selectedId}
          playOrder={playOrderMap.get(c.id) ?? 0}
          pxPerSec={pxPerSec}
          onSelect={onSelect}
          onChange={onChange}
          onTrim={onTrim}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  )
})

type DragMode = 'move' | 'resize-left' | 'resize-right'

interface DragState {
  mode: DragMode
  startX: number
  startIn: number
  startOut: number
  /** The newest pointer x — applied at most once per frame. */
  lastX: number
  /** The pending animation frame, or 0. */
  frame: number
}

const SourceCutBlock = memo(function SourceCutBlock({
  cut,
  minIn,
  maxOut,
  selected,
  playOrder,
  pxPerSec,
  onSelect,
  onChange,
  onTrim,
  onDragStart,
  onDragEnd
}: {
  cut: WorkingCut
  /** How far the block may go without overlapping its lane neighbours. */
  minIn: number
  maxOut: number
  selected: boolean
  playOrder: number
  pxPerSec: number
  onSelect: (cut: WorkingCut) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onTrim: (cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) => void
  onDragStart: () => void
  onDragEnd: () => void
}): React.JSX.Element {
  const dragState = useRef<DragState | null>(null)

  function onPointerDown(e: React.PointerEvent): void {
    if (e.button !== 0) return
    e.stopPropagation()
    // Selected on press, not on release — see EditedCutBlock.
    onSelect(cut)
    onDragStart()
    dragState.current = {
      mode: 'move',
      startX: e.clientX,
      startIn: cut.in,
      startOut: cut.out,
      lastX: e.clientX,
      frame: 0
    }
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
  }

  function applyMove(d: DragState): void {
    const deltaSec = (d.lastX - d.startX) / pxPerSec
    if (d.mode === 'move') {
      const dur = d.startOut - d.startIn
      const newIn = clamp(d.startIn + deltaSec, minIn, maxOut - dur)
      onChange(cut.id, { in: newIn, out: newIn + dur })
    }
  }

  function onPointerMove(e: React.PointerEvent): void {
    const d = dragState.current
    if (!d) return
    // One update per frame, not per pointer event — see bindTrimDrag. Every
    // update re-renders the lane, and a trackpad delivers several per frame.
    d.lastX = e.clientX
    if (d.frame) return
    d.frame = window.requestAnimationFrame(() => {
      d.frame = 0
      applyMove(d)
    })
  }

  function onPointerUp(e: React.PointerEvent): void {
    const d = dragState.current
    // Land the last position before the edit is committed to history.
    if (d?.frame) {
      window.cancelAnimationFrame(d.frame)
      d.frame = 0
      applyMove(d)
    }
    if (d) onDragEnd()
    dragState.current = null
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge): void {
    onSelect(cut)
    bindTrimDrag({
      e,
      edge,
      pxPerSec,
      startIn: cut.in,
      startOut: cut.out,
      minIn,
      maxOut,
      // Through the editor, which also keeps the edge on the preview.
      onChange: (patch) => onTrim(cut, edge, patch, cut.in),
      onDragStart,
      onDragEnd
    })
  }

  const left = cut.in * pxPerSec
  const width = Math.max((cut.out - cut.in) * pxPerSec, 8)

  return (
    <div
      data-cut-block
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`absolute inset-y-0 cursor-grab rounded-[5px] border bg-black/35 active:cursor-grabbing ${
        selected ? 'border-accent' : 'border-accent/45 hover:border-accent/70'
      }`}
      style={{ left, width }}
    >
      <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink">
        {playOrder || ''}
      </span>
      {(selected || edgeZonePx(width) > 0) && (
        <>
          <TrimBar
            edge="left"
            visible={selected}
            zonePx={edgeZonePx(width)}
            onTrimDown={onTrimDown}
          />
          <TrimBar
            edge="right"
            visible={selected}
            zonePx={edgeZonePx(width)}
            onTrimDown={onTrimDown}
          />
        </>
      )}
    </div>
  )
})
