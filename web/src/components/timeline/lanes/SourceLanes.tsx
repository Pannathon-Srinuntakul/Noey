import { memo, useMemo, useState } from 'react'
import type { EditTimelineSource } from '../../../lib/editorApi'
import { bindPointerDrag, type DragScroller } from '../../../lib/pointerDrag'
import { sourceNeighborBoundsById, type TrimEdge } from '../../../lib/timelineMath'
import { quantizeToFrame, snapSpan } from '../../../lib/timelineSnap'
import type { FilmstripStrip, FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { FilmstripCanvas } from '../../FilmstripCanvas'
import { HEADER_COL_PX, IMG_LANE_PX, MIN_LANE_PX, edgeZonePx } from '../constants'
import type { SnapContext, WorkingCut } from '../types'
import { DragReadout } from './DragReadout'
import {
  selectModsOf,
  slipReadoutText,
  trimFrame,
  trimReadoutText,
  type SelectMods,
  type TrimReadout
} from './sceneLabel'
import { TrackRow } from './TrackRow'
import { TrimBar } from './TrimBar'

/** A lane with no scenes — one array, so its row can skip renders. */
const NO_CUTS: WorkingCut[] = []
const NO_IDS: ReadonlySet<string> = new Set()

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
  selectedIds = NO_IDS,
  coarse = false,
  pxPerSec,
  contentW,
  leadPx = 0,
  getSnapContext,
  dragScroller,
  onSourceLanePointerDown,
  onSelectCut,
  onContextMenu,
  onUpdateCut,
  onTrimCut,
  onSlip,
  onFocusEdge,
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
  selectedIds?: ReadonlySet<string>
  coarse?: boolean
  pxPerSec: number
  contentW: number
  leadPx?: number
  getSnapContext: () => SnapContext
  dragScroller?: DragScroller
  onSourceLanePointerDown: (sourceId: string, e: React.PointerEvent) => void
  onSelectCut: (cut: WorkingCut, mods: SelectMods) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
  onUpdateCut: (id: string, patch: Partial<WorkingCut>) => void
  /** A trim-handle drag step — the editor applies it and shows the edge. */
  onTrimCut: (
    cut: WorkingCut,
    edge: TrimEdge,
    patch: Partial<WorkingCut>,
    prevIn: number,
    readout: TrimReadout
  ) => void
  /** A block move — the window slides inside the file; the editor applies it
   * and shows both ends. */
  onSlip?: (cut: WorkingCut, patch: { in: number; out: number }) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
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
          leadPx={leadPx}
          role="listbox"
          ariaLabel={`คลิป ${src.id}`}
          onLanePointerDown={(e) => onSourceLanePointerDown(src.id, e)}
        >
          <SourceLaneRow
            laneDurationSec={laneDurationById.get(src.id) ?? 0}
            strip={strips[src.id] ?? null}
            pending={filmstripPending}
            cuts={cutsBySource.get(src.id) ?? NO_CUTS}
            playOrderMap={playOrderMap}
            selectedId={selectedId}
            selectedIds={selectedIds}
            coarse={coarse}
            pxPerSec={pxPerSec}
            leadPx={leadPx}
            isActive={previewSource === src.id}
            getSnapContext={getSnapContext}
            dragScroller={dragScroller}
            onSelect={onSelectCut}
            onContextMenu={onContextMenu}
            onChange={onUpdateCut}
            onTrim={onTrimCut}
            onSlip={onSlip}
            onFocusEdge={onFocusEdge}
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
  selectedIds,
  coarse,
  pxPerSec,
  leadPx,
  isActive,
  getSnapContext,
  dragScroller,
  onSelect,
  onContextMenu,
  onChange,
  onTrim,
  onSlip,
  onFocusEdge,
  onDragStart,
  onDragEnd
}: {
  laneDurationSec: number
  strip: FilmstripStrip | null
  pending?: boolean
  cuts: WorkingCut[]
  playOrderMap: Map<string, number>
  selectedId: string | null
  selectedIds: ReadonlySet<string>
  coarse: boolean
  pxPerSec: number
  leadPx: number
  isActive: boolean
  getSnapContext: () => SnapContext
  dragScroller?: DragScroller
  onSelect: (c: WorkingCut, mods: SelectMods) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onTrim: (
    cut: WorkingCut,
    edge: TrimEdge,
    patch: Partial<WorkingCut>,
    prevIn: number,
    readout: TrimReadout
  ) => void
  onSlip?: (cut: WorkingCut, patch: { in: number; out: number }) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
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
      // Clipped on x only: the drag readout hangs above the lane.
      className={`relative h-full overflow-x-clip rounded-md border bg-surface ${
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
        laneLeftPx={HEADER_COL_PX + leadPx}
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
          multiSelected={c.id !== selectedId && selectedIds.has(c.id)}
          coarse={coarse}
          playOrder={playOrderMap.get(c.id) ?? 0}
          pxPerSec={pxPerSec}
          getSnapContext={getSnapContext}
          dragScroller={dragScroller}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onChange={onChange}
          onTrim={onTrim}
          onSlip={onSlip}
          onFocusEdge={onFocusEdge}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  )
})

/** What a live drag draws over the block. */
interface LiveDrag {
  edge: TrimEdge | null
  text: string
  atLimit: boolean
}

const SourceCutBlock = memo(function SourceCutBlock({
  cut,
  minIn,
  maxOut,
  selected,
  multiSelected,
  coarse,
  playOrder,
  pxPerSec,
  getSnapContext,
  dragScroller,
  onSelect,
  onContextMenu,
  onChange,
  onTrim,
  onSlip,
  onFocusEdge,
  onDragStart,
  onDragEnd
}: {
  cut: WorkingCut
  /** How far the block may go without overlapping its lane neighbours. */
  minIn: number
  maxOut: number
  selected: boolean
  multiSelected: boolean
  coarse: boolean
  playOrder: number
  pxPerSec: number
  getSnapContext: () => SnapContext
  dragScroller?: DragScroller
  onSelect: (cut: WorkingCut, mods: SelectMods) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onTrim: (
    cut: WorkingCut,
    edge: TrimEdge,
    patch: Partial<WorkingCut>,
    prevIn: number,
    readout: TrimReadout
  ) => void
  onSlip?: (cut: WorkingCut, patch: { in: number; out: number }) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
  onDragStart: () => void
  onDragEnd: () => void
}): React.JSX.Element {
  const [live, setLive] = useState<LiveDrag | null>(null)

  /** Drag the block: the window slides inside the file (a slip on the source
   * clock), both edges snapping to the file's other scenes, its ends and the
   * playhead when it is on this file. */
  function onPointerDown(e: React.PointerEvent): void {
    if (e.button !== 0) return
    if ((e.target as Element | null)?.closest?.('[data-trim-handle]')) return
    e.stopPropagation()
    // Selected on press, not on release — see EditedCutBlock.
    onSelect(cut, selectModsOf(e))
    // A selection gesture is not a drag.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return
    const ctx = getSnapContext()
    const startCut = cut
    const startIn = cut.in
    const startOut = cut.out
    const dur = startOut - startIn
    // Pointer capture stays on the element: the drag survives the pointer
    // leaving the block, and the window listeners still see every move.
    const target = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    target.setPointerCapture(pointerId)
    onDragStart()
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const snapActive = ctx.isActive() && !f.altKey
        const rawIn = quantizeToFrame(startIn + f.deltaSec)
        const r = snapActive
          ? snapSpan({
              start: rawIn,
              end: rawIn + dur,
              minStart: minIn,
              maxEnd: maxOut,
              targets: ctx.sourceTargets(startCut.source, { excludeCutId: startCut.id }),
              tolSec: ctx.tolSec()
            })
          : {
              start: Math.max(minIn, Math.min(rawIn, maxOut - dur)),
              end: Math.max(minIn, Math.min(rawIn, maxOut - dur)) + dur,
              hit: null
            }
        ctx.report(r.hit, 'source')
        const patch = { in: r.start, out: r.end }
        if (onSlip) onSlip(startCut, patch)
        else onChange(startCut.id, patch)
        setLive({ edge: null, text: slipReadoutText(r.start - startIn), atLimit: false })
      },
      onEnd({ cancelled }) {
        if (cancelled) onChange(startCut.id, { in: startIn, out: startOut })
        ctx.report(null, 'source')
        setLive(null)
        onDragEnd()
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      }
    })
  }

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge): void {
    if (e.button !== 0) return
    onSelect(cut, { shift: false, toggle: false })
    const ctx = getSnapContext()
    const startCut = cut
    const startIn = cut.in
    const startOut = cut.out
    onDragStart()
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const snapActive = ctx.isActive() && !f.altKey
        const r = trimFrame({
          edge,
          cut: startCut,
          startIn,
          startOut,
          minIn,
          maxOut,
          deltaSec: f.deltaSec,
          snapActive,
          targets: snapActive
            ? ctx.sourceTargets(startCut.source, { excludeCutId: startCut.id })
            : [],
          tolSec: ctx.tolSec(),
          clock: 'source',
          startOffsetSec: 0
        })
        ctx.report(r.hit, 'source')
        // Through the editor, which also keeps the edge on the preview.
        onTrim(startCut, edge, r.patch, startIn, r.readout)
        setLive({ edge, text: trimReadoutText(r.readout), atLimit: r.atLimit })
      },
      onEnd({ cancelled }) {
        if (cancelled) onChange(startCut.id, { in: startIn, out: startOut })
        ctx.report(null, 'source')
        setLive(null)
        onDragEnd()
      }
    })
  }

  const left = cut.in * pxPerSec
  const width = Math.max((cut.out - cut.in) * pxPerSec, 8)
  const zonePx = edgeZonePx(width, coarse)
  const border = selected
    ? 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]'
    : multiSelected
      ? 'border-dashed border-accent'
      : 'border-accent/45 hover:border-accent/70'

  return (
    <div
      data-cut-block
      data-cut-id={cut.id}
      role="option"
      aria-selected={selected || multiSelected}
      aria-label={`ฉาก ${playOrder}`}
      tabIndex={selected ? 0 : -1}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        if (!onContextMenu) return
        e.preventDefault()
        if (!selected && !multiSelected) onSelect(cut, { shift: false, toggle: false })
        onContextMenu(cut, { x: e.clientX, y: e.clientY })
      }}
      className={`group absolute inset-y-0 rounded-[5px] border bg-black/35 focus-visible:outline-offset-[3px]! ${
        live ? 'cursor-ew-resize' : 'cursor-grab active:cursor-grabbing'
      } ${coarse ? 'touch-none' : ''} ${border}`}
      style={{ left, width }}
    >
      <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink">
        {playOrder || ''}
      </span>
      {(selected || zonePx > 0) && (
        <>
          <TrimBar
            edge="left"
            visible={selected}
            zonePx={zonePx}
            sceneNumber={playOrder}
            min={minIn}
            max={cut.out}
            value={cut.in}
            atLimit={live?.edge === 'left' && live.atLimit}
            cutId={cut.id}
            onTrimDown={onTrimDown}
            onFocusEdge={onFocusEdge}
          />
          <TrimBar
            edge="right"
            visible={selected}
            zonePx={zonePx}
            sceneNumber={playOrder}
            min={cut.in}
            max={maxOut}
            value={cut.out}
            atLimit={live?.edge === 'right' && live.atLimit}
            cutId={cut.id}
            onTrimDown={onTrimDown}
            onFocusEdge={onFocusEdge}
          />
        </>
      )}
      {live && (
        <DragReadout
          text={live.text}
          anchor={live.edge ?? 'center'}
          tone={live.atLimit ? 'limit' : 'default'}
        />
      )}
    </div>
  )
})
