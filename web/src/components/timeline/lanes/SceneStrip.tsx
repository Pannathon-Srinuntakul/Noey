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
  type KeyboardSensorOptions,
  type PointerSensorOptions,
  type TouchSensorOptions
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EyeOff, MoreHorizontal, Repeat2, UserRoundPen } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'
import type { FilmstripStripMap } from '../../../lib/useFilmstripStrips'
import { LONG_PRESS_MS } from '../constants'
import type { WorkingCut } from '../types'
import { FilmstripThumb } from '../FilmstripThumb'
import { shouldStartReorder } from './marquee'
import { selectModsOf, stripTileFor, type SelectMods } from './sceneLabel'

/** Thumbnail size — a 16:10 tile a thumb can hit. */
const TILE_W = 64
const TILE_H = 40

/** Two taps within this are a double-tap (open). */
const DOUBLE_TAP_MS = 300

/** The strip's press activator: a finger holds (TouchSensor), a mouse drags
 * 6px, modifiers and the ⋯ button never pick a tile up. */
class StripPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (
        { nativeEvent: event }: React.PointerEvent,
        { onActivation }: PointerSensorOptions
      ): boolean => {
        if (!event.isPrimary) return false
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

const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 6 } }
const TOUCH_SENSOR_OPTIONS: TouchSensorOptions = {
  activationConstraint: { delay: LONG_PRESS_MS, tolerance: 5 }
}
const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ['Enter'], cancel: ['Escape'], end: ['Enter', 'Tab'] }
}

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * Phone storyboard (Descript's storyboard / CapCut mobile's clip strip): one
 * thumbnail per scene in play order, scrolling sideways. Tap selects,
 * double-tap opens, a long press picks a tile up to reorder, ⋯ opens the
 * scene menu. Shown instead of the lanes on a narrow touch layout.
 */
export const SceneStrip = memo(function SceneStrip({
  cuts,
  strips,
  selectedIds = NO_IDS,
  primaryId = null,
  playOrderMap,
  skippedIds = NO_IDS,
  onSelect,
  onOpen,
  onReorder,
  onContextMenu
}: {
  cuts: WorkingCut[]
  strips: FilmstripStripMap
  selectedIds?: ReadonlySet<string>
  /** The primary selection, drawn heavier than the rest. */
  primaryId?: string | null
  playOrderMap: Map<string, number>
  skippedIds?: ReadonlySet<string>
  onSelect: (cut: WorkingCut, mods: SelectMods) => void
  onOpen: (cut: WorkingCut) => void
  onReorder: (activeId: string, overId: string) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(StripPointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  )
  const idsKey = cuts.map((c) => c.id).join('|')
  const ids = useMemo(() => (idsKey ? idsKey.split('|') : []), [idsKey])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeCut = activeId ? (cuts.find((c) => c.id === activeId) ?? null) : null

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null)
    if (e.over && e.over.id !== e.active.id) onReorder(String(e.active.id), String(e.over.id))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        <ul
          role="listbox"
          aria-label="ลำดับฉาก"
          aria-multiselectable="true"
          tabIndex={0}
          className="flex h-full items-center gap-2 overflow-x-auto overflow-y-hidden px-4 py-2"
        >
          {cuts.map((c) => (
            <SceneTile
              key={c.id}
              cut={c}
              strip={strips[c.source] ?? null}
              playOrder={playOrderMap.get(c.id) ?? 0}
              selected={selectedIds.has(c.id)}
              primary={c.id === primaryId}
              skipped={skippedIds.has(c.id)}
              onSelect={onSelect}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeCut ? (
          <div
            className="overflow-hidden rounded-md border-2 border-accent bg-surface opacity-80 shadow-lg"
            style={{ width: TILE_W, height: TILE_H }}
          >
            <Thumb cut={activeCut} strip={strips[activeCut.source] ?? null} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
})

/** The tile nearest the scene's in-point, over a neutral placeholder. */
function Thumb({
  cut,
  strip
}: {
  cut: WorkingCut
  strip: FilmstripStripMap[string] | null
}): React.JSX.Element {
  const idx = stripTileFor(strip, cut.in)
  return <FilmstripThumb url={strip && idx !== null ? strip.urlFor(idx) : null} />
}

const SceneTile = memo(function SceneTile({
  cut,
  strip,
  playOrder,
  selected,
  primary,
  skipped,
  onSelect,
  onOpen,
  onContextMenu
}: {
  cut: WorkingCut
  strip: FilmstripStripMap[string] | null
  playOrder: number
  selected: boolean
  primary: boolean
  skipped: boolean
  onSelect: (cut: WorkingCut, mods: SelectMods) => void
  onOpen: (cut: WorkingCut) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cut.id
  })
  const lastTapRef = useRef(0)
  const alternates = Array.isArray(cut.meta?.alternates) ? cut.meta.alternates.length : 0
  const swapped = !!cut.meta?.swappedFrom

  /** Tap = select; a second tap within DOUBLE_TAP_MS = open. Selection
   * happens on the first tap, so the double-tap costs nothing. */
  function onClick(e: React.MouseEvent): void {
    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0
      onOpen(cut)
      return
    }
    lastTapRef.current = now
    onSelect(cut, selectModsOf(e))
  }

  return (
    <li
      ref={setNodeRef}
      data-cut-id={cut.id}
      style={{
        transform: isDragging ? undefined : CSS.Transform.toString(transform),
        transition,
        width: TILE_W,
        opacity: isDragging ? 0.35 : undefined
      }}
      // No `touch-none`: a swipe across the tiles scrolls the strip; the
      // TouchSensor takes over only once the long press has fired.
      className="relative shrink-0 list-none"
      {...attributes}
      {...listeners}
      role="option"
      aria-selected={selected}
      aria-label={`ฉาก ${playOrder}${skipped ? ' (ข้ามอยู่)' : ''}`}
      tabIndex={primary ? 0 : -1}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onContextMenu) return
        e.preventDefault()
        if (!selected) onSelect(cut, { shift: false, toggle: false })
        onContextMenu(cut, { x: e.clientX, y: e.clientY })
      }}
    >
      <div
        className={`relative overflow-hidden rounded-md border-2 bg-surface ${
          primary ? 'border-accent' : selected ? 'border-dashed border-accent' : 'border-border'
        } ${skipped ? 'opacity-40 grayscale' : ''}`}
        style={{ width: TILE_W, height: TILE_H }}
      >
        <Thumb cut={cut} strip={strip} />
        <span className="absolute bottom-0.5 left-1 z-10 text-[12px] font-semibold tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
          {playOrder}
        </span>
        <span className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex items-center gap-0.5">
          {skipped && (
            <span
              title="ฉากนี้ถูกข้าม"
              className="flex items-center rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-muted"
            >
              <EyeOff size={10} />
            </span>
          )}
          {alternates > 0 && (
            <span
              title={`มีช็อตสำรอง ${alternates} ช็อต`}
              className="flex items-center gap-px rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-[10px] font-semibold leading-none tabular-nums text-ink"
            >
              <Repeat2 size={10} />
              {alternates}
            </span>
          )}
          {swapped && (
            <span
              title="ช็อตนี้คุณเปลี่ยนเอง"
              className="flex items-center rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-accent"
            >
              <UserRoundPen size={10} />
            </span>
          )}
        </span>
      </div>
      {onContextMenu && (
        /* `data-trim-handle` keeps the reorder activator off the button. */
        <button
          type="button"
          data-trim-handle
          aria-label={`เมนูของฉาก ${playOrder}`}
          title="เมนูฉาก"
          className="absolute -right-1 -top-1 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-[rgb(28_28_30_/_0.92)] text-ink-3 hover:text-ink"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            if (!selected) onSelect(cut, { shift: false, toggle: false })
            onContextMenu(cut, { x: r.left, y: r.bottom })
          }}
        >
          <MoreHorizontal size={12} />
        </button>
      )}
    </li>
  )
})
