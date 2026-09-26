import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
  type TouchSensorOptions
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { memo, useMemo, useRef, useState } from 'react'
import { bindPointerDrag, type DragScroller } from '../../../lib/pointerDrag'
import type { TrimEdge } from '../../../lib/timelineMath'
import type { FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { FilmstripCanvas } from '../../FilmstripCanvas'
import { HEADER_COL_PX, IMG_LANE_PX, LONG_PRESS_MS } from '../constants'
import type { SnapContext, WorkingCut } from '../types'
import { EditedCutBlock, type SelectMods, type TrimReadout } from './EditedCutBlock'
import { marqueeHits, marqueeMoved, normalizeBox, shouldStartReorder } from './marquee'
import { reorderHint } from './sceneLabel'
import { TrackRow } from './TrackRow'

/**
 * dnd-kit's PointerSensor with the lane's own activator: a press that is a
 * slip (Alt), a selection gesture (Shift / ⌘ / Ctrl), a trim handle, a
 * secondary button or a finger (the TouchSensor's long press owns those) never
 * picks a block up. The predicate is `marquee.shouldStartReorder`, tested.
 */
class LanePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (
        { nativeEvent: event }: React.PointerEvent,
        { onActivation }: PointerSensorOptions
      ): boolean => {
        if (!event.isPrimary) return false
        // Field by field: a native event's properties live on its prototype,
        // so a spread would copy none of them.
        const ok = shouldStartReorder({
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          button: event.button,
          pointerType: event.pointerType,
          target: event.target as Element | null
        })
        if (!ok) return false
        onActivation?.({ event })
        return true
      }
    }
  ]
}

// useSensor memoizes on its options object: a fresh one per render built new
// sensors, a new DndContext value, and a render of every block in the lane.
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 4 } }
// A finger holds to pick up (CapCut mobile); a swipe under the delay scrolls.
const TOUCH_SENSOR_OPTIONS: TouchSensorOptions = {
  activationConstraint: { delay: LONG_PRESS_MS, tolerance: 5 }
}
// Space is the editor's play/pause, everywhere. dnd-kit also starts a keyboard
// drag on Space by default, so a block focused by a click was picked up by the
// same key that played the clip — and the arrows then moved the block instead
// of the playhead (owner, 2026-09-22). Enter still picks a block up.
const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: ['Enter'],
    cancel: ['Escape'],
    end: ['Enter', 'Tab']
  }
}

const NO_IDS: ReadonlySet<string> = new Set()

/** ภาพ — the edited sequence, one block per scene, back to back. Drag a block
 * to reorder (a ghost follows the pointer, the neighbours open a gap, a
 * caption says where it lands), its edges to trim; Shift+drag the background
 * to marquee-select. */
export const ImageLane = memo(function ImageLane({
  cuts,
  selectedId,
  selectedIds = NO_IDS,
  playOrderMap,
  strips,
  filmstripPending,
  sourceDurationById,
  sourceLabelById,
  pxPerSec,
  contentW,
  leadPx = 0,
  coarse = false,
  focusedEdge = null,
  skippedIds = NO_IDS,
  editedInById,
  getSnapContext,
  dragScroller,
  onLaneBackgroundPointerDown,
  onSelectCut,
  onOpenCut,
  onContextMenu,
  onUpdateCut,
  onTrimCut,
  onRoll,
  onSlip,
  onFocusEdge,
  onMarquee,
  onBlockEditStart,
  onBlockEditEnd,
  onReorder,
  onReorderMany
}: {
  cuts: WorkingCut[]
  /** The primary selection. */
  selectedId: string | null
  /** The whole selection (the primary included). */
  selectedIds?: ReadonlySet<string>
  playOrderMap: Map<string, number>
  strips: FilmstripStripMap
  /** The thumbnail extraction is still running. */
  filmstripPending: boolean
  sourceDurationById: Map<string, number>
  /** Each source's name as the user knows it, for the scene tooltip. */
  sourceLabelById?: Map<string, string>
  pxPerSec: number
  contentW: number
  /** Padding before the axis (touch-scrub mode). */
  leadPx?: number
  /** A touch pointer — see EditedCutBlock. */
  coarse?: boolean
  /** The handle holding the roving focus, if any. */
  focusedEdge?: { cutId: string; edge: TrimEdge } | null
  /** Scenes drawn as skipped stubs (timelineMath.isSkipped). */
  skippedIds?: ReadonlySet<string>
  /** Each scene's start on the edited clock. */
  editedInById: Map<string, number>
  getSnapContext: () => SnapContext
  dragScroller?: DragScroller
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  onSelectCut: (cut: WorkingCut, mods: SelectMods) => void
  /** Double-click on a block — see EditedCutBlock's onOpen. */
  onOpenCut: (cut: WorkingCut) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
  onUpdateCut: (id: string, patch: Partial<WorkingCut>) => void
  onTrimCut: (
    cut: WorkingCut,
    edge: TrimEdge,
    patch: Partial<WorkingCut>,
    prevIn: number,
    readout: TrimReadout
  ) => void
  onRoll?: (cutId: string, edge: TrimEdge, deltaSec: number) => void
  onSlip?: (cut: WorkingCut, patch: { in: number; out: number }) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
  /** A marquee landed on these scenes (additive: Shift was held to start it). */
  onMarquee?: (ids: string[], additive: boolean) => void
  onBlockEditStart: () => void
  onBlockEditEnd: () => void
  onReorder: (e: DragEndEvent) => void
  /** The dragged block was part of a multi-selection: move them all, in play
   * order, to where the drop landed. */
  onReorderMany?: (ids: string[], overId: string) => void
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(LanePointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  )
  // SortableContext hands its items to every block through context, so a new
  // array renders them all. It is rebuilt only when the ids or their order
  // change — a trim changes neither. Cut ids (cut<n>, new<n>) never hold a '|'.
  const idsKey = cuts.map((c) => c.id).join('|')
  const ids = useMemo(() => (idsKey ? idsKey.split('|') : []), [idsKey])

  // ---- reorder ghost ---------------------------------------------------------
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState(-1)
  const activeIndex = activeId ? ids.indexOf(activeId) : -1
  const activeCut = activeIndex >= 0 ? cuts[activeIndex] : null

  function onDragStart(e: DragStartEvent): void {
    const id = String(e.active.id)
    setActiveId(id)
    setOverIndex(ids.indexOf(id))
  }
  function onDragOver(e: DragOverEvent): void {
    setOverIndex(e.over ? ids.indexOf(String(e.over.id)) : -1)
  }
  function onDragCancel(): void {
    setActiveId(null)
  }
  function handleDragEnd(e: DragEndEvent): void {
    setActiveId(null)
    const id = String(e.active.id)
    if (e.over && onReorderMany && selectedIds.size > 1 && selectedIds.has(id)) {
      onReorderMany(
        cuts.filter((c) => selectedIds.has(c.id)).map((c) => c.id),
        String(e.over.id)
      )
      return
    }
    onReorder(e)
  }

  // ---- marquee ---------------------------------------------------------------
  const laneRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{ left: number; width: number } | null>(null)

  function onLaneDown(e: React.PointerEvent): void {
    const onBlock = !!(e.target as Element | null)?.closest?.('[data-cut-block]')
    if (e.shiftKey && e.button === 0 && !onBlock && onMarquee) {
      startMarquee(e)
      return
    }
    onLaneBackgroundPointerDown(e)
  }

  function startMarquee(e: React.PointerEvent): void {
    const lane = laneRef.current
    if (!lane) return
    let last: { clientX: number; deltaPx: number } | null = null
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        last = { clientX: f.clientX, deltaPx: f.deltaPx }
        // deltaPx carries the auto-scroll, so clientX − deltaPx is where the
        // press point sits on screen NOW.
        const rect = lane.getBoundingClientRect()
        const x0 = f.clientX - f.deltaPx - rect.left
        const x1 = f.clientX - rect.left
        setMarquee({ left: Math.min(x0, x1), width: Math.abs(x1 - x0) })
      },
      onEnd({ cancelled }) {
        setMarquee(null)
        const f = last
        // Under MARQUEE_MIN_PX it was a Shift+click on the background — not a
        // scrub, not a selection change.
        if (cancelled || !f || !marqueeMoved(f.deltaPx, 0)) return
        const rect = lane.getBoundingClientRect()
        const box = normalizeBox(f.clientX - f.deltaPx, rect.top, f.clientX, rect.bottom)
        const rects = Array.from(lane.querySelectorAll<HTMLElement>('[data-cut-id]')).map((el) => {
          const r = el.getBoundingClientRect()
          return {
            id: el.dataset.cutId ?? '',
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom
          }
        })
        onMarquee?.(marqueeHits(rects, box), true)
      }
    })
  }

  return (
    <TrackRow
      heightPx={IMG_LANE_PX}
      label={
        <>
          ภาพ
          <span className="tabular-nums text-ink-3">{cuts.length}</span>
        </>
      }
      laneClassName="relative h-full cursor-crosshair"
      contentW={contentW}
      leadPx={leadPx}
      laneRef={laneRef}
      onLanePointerDown={onLaneDown}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragCancel={onDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <ul
            role="listbox"
            aria-label="ลำดับฉาก"
            aria-multiselectable="true"
            // One Tab stop for the lane; the selected block is the roving one.
            tabIndex={0}
            className="flex h-full items-stretch"
          >
            {cuts.map((c) => (
              <EditedCutBlock
                key={c.id}
                cut={c}
                selected={c.id === selectedId}
                multiSelected={c.id !== selectedId && selectedIds.has(c.id)}
                focusedEdge={focusedEdge?.cutId === c.id ? focusedEdge.edge : null}
                skipped={skippedIds.has(c.id)}
                coarse={coarse}
                playOrder={playOrderMap.get(c.id) ?? 0}
                sceneCount={cuts.length}
                strip={strips[c.source] ?? null}
                pending={filmstripPending}
                sourceDurationSec={sourceDurationById.get(c.source) ?? 0}
                sourceMissing={!sourceDurationById.has(c.source)}
                sourceLabel={sourceLabelById?.get(c.source)}
                pxPerSec={pxPerSec}
                leadPx={leadPx}
                onSelect={onSelectCut}
                onOpen={onOpenCut}
                onContextMenu={onContextMenu}
                onChange={onUpdateCut}
                onTrim={onTrimCut}
                onRoll={onRoll}
                onSlip={onSlip}
                onFocusEdge={onFocusEdge}
                onDragStart={onBlockEditStart}
                onDragEnd={onBlockEditEnd}
                startOffsetSec={editedInById.get(c.id) ?? 0}
                getSnapContext={getSnapContext}
                dragScroller={dragScroller}
              />
            ))}
          </ul>
        </SortableContext>
        {/* The ghost that follows the pointer, at the block's full width, with
            where it will land. The origin block stays dimmed in its slot. */}
        <DragOverlay dropAnimation={null}>
          {activeCut ? (
            <div
              className="relative overflow-hidden rounded-[5px] border-2 border-accent bg-black opacity-75 shadow-lg"
              style={{
                width: Math.max((activeCut.out - activeCut.in) * pxPerSec, 24),
                height: IMG_LANE_PX
              }}
            >
              <FilmstripCanvas
                strip={strips[activeCut.source] ?? null}
                pending={filmstripPending}
                sourceStartSec={activeCut.in}
                laneWidthPx={Math.max((activeCut.out - activeCut.in) * pxPerSec, 24)}
                heightPx={IMG_LANE_PX}
                laneLeftPx={
                  HEADER_COL_PX + leadPx + (editedInById.get(activeCut.id) ?? 0) * pxPerSec
                }
                pxPerSec={pxPerSec}
                opacity={0.6}
              />
              <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
                {playOrderMap.get(activeCut.id) ?? ''}
              </span>
              <span className="absolute left-1/2 top-0.5 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm bg-[rgb(28_28_30_/_0.9)] px-1 py-px text-[11px] font-medium text-ink">
                {reorderHint(overIndex, cuts.length, activeIndex)}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {marquee && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-30 rounded-sm border border-accent bg-accent/15"
          style={{ left: marquee.left, width: marquee.width }}
        />
      )}
    </TrackRow>
  )
})
