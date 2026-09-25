import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type KeyboardSensorOptions,
  type PointerSensorOptions
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { memo, useMemo } from 'react'
import type { TrimEdge } from '../../../lib/timelineMath'
import type { FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { IMG_LANE_PX } from '../constants'
import type { TrimSnapContext, WorkingCut } from '../types'
import { EditedCutBlock } from './EditedCutBlock'
import { TrackRow } from './TrackRow'

// useSensor memoizes on its options object: a fresh one per render built new
// sensors, a new DndContext value, and a render of every block in the lane.
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 5 } }
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

/** ภาพ — the edited sequence, one block per scene, back to back. Drag a block
 * to reorder, its gold edges to trim. */
export const ImageLane = memo(function ImageLane({
  cuts,
  selectedId,
  playOrderMap,
  strips,
  filmstripPending,
  sourceDurationById,
  pxPerSec,
  contentW,
  editedInById,
  getSnapContext,
  onLaneBackgroundPointerDown,
  onSelectCut,
  onOpenCut,
  onUpdateCut,
  onTrimCut,
  onBlockEditStart,
  onBlockEditEnd,
  onReorder
}: {
  cuts: WorkingCut[]
  selectedId: string | null
  playOrderMap: Map<string, number>
  strips: FilmstripStripMap
  /** The thumbnail extraction is still running. */
  filmstripPending: boolean
  sourceDurationById: Map<string, number>
  pxPerSec: number
  contentW: number
  /** Each scene's start on the edited clock. */
  editedInById: Map<string, number>
  getSnapContext: () => TrimSnapContext
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  onSelectCut: (cut: WorkingCut) => void
  /** Double-click on a block — see EditedCutBlock's onOpen. */
  onOpenCut: (cut: WorkingCut) => void
  onUpdateCut: (id: string, patch: Partial<WorkingCut>) => void
  onTrimCut: (cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) => void
  onBlockEditStart: () => void
  onBlockEditEnd: () => void
  onReorder: (e: DragEndEvent) => void
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  )
  // SortableContext hands its items to every block through context, so a new
  // array renders them all. It is rebuilt only when the ids or their order
  // change — a trim changes neither. Cut ids (cut<n>, new<n>) never hold a '|'.
  const idsKey = cuts.map((c) => c.id).join('|')
  const ids = useMemo(() => (idsKey ? idsKey.split('|') : []), [idsKey])
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
      onLanePointerDown={onLaneBackgroundPointerDown}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <ul className="flex h-full items-stretch">
            {cuts.map((c) => (
              <EditedCutBlock
                key={c.id}
                cut={c}
                selected={c.id === selectedId}
                playOrder={playOrderMap.get(c.id) ?? 0}
                strip={strips[c.source] ?? null}
                pending={filmstripPending}
                sourceDurationSec={sourceDurationById.get(c.source) ?? 0}
                sourceMissing={!sourceDurationById.has(c.source)}
                pxPerSec={pxPerSec}
                onSelect={onSelectCut}
                onOpen={onOpenCut}
                onChange={onUpdateCut}
                onTrim={onTrimCut}
                onDragStart={onBlockEditStart}
                onDragEnd={onBlockEditEnd}
                startOffsetSec={editedInById.get(c.id) ?? 0}
                getSnapContext={getSnapContext}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </TrackRow>
  )
})
