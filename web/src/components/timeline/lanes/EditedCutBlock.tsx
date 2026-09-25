import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, Repeat2, Sparkles, UserRoundPen } from 'lucide-react'
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

/** Under this the block only has room for the problem marker. */
const BADGE_ROOM_PX = 38

interface SceneState {
  /** R18b backup shots the AI returned with this scene. */
  alternates: number
  /** The user swapped this shot themselves (shotSwap keeps the AI's pick in
   * `swappedFrom`). */
  swapped: boolean
  /** The AI picked this window — an edit-script segment, not a hand-made cut. */
  fromAi: boolean
}

/**
 * What the AI's per-shot data says about this scene (see EditCut.meta).
 *
 * Read here rather than handed down: it only ever changes when the cut object
 * does, which is exactly when this memo()'d block renders anyway. Until now
 * none of it was on screen at all — the alternates in particular were
 * invisible until you opened ปรับช็อต, so nobody knew the feature was there.
 */
function sceneStateOf(cut: WorkingCut): SceneState {
  const meta = cut.meta
  return {
    alternates: Array.isArray(meta?.alternates) ? meta.alternates.length : 0,
    swapped: !!meta?.swappedFrom,
    fromAi: meta?.matchedFrameTime !== undefined
  }
}

/** Why this scene cannot render as it stands, in the user's words — or null. */
function sceneProblem(
  cut: WorkingCut,
  sourceMissing: boolean,
  sourceDurationSec: number
): string | null {
  if (sourceMissing) return 'ไม่พบไฟล์ต้นฉบับของฉากนี้'
  if (cut.out - cut.in <= 0) return 'ฉากนี้ไม่มีความยาว'
  // A hair of slack: probe durations round, and a cut that ends on the last
  // frame is fine.
  if (sourceDurationSec > 0 && cut.out > sourceDurationSec + 0.05) {
    return 'ช่วงของฉากนี้ยาวเกินไฟล์ต้นฉบับ'
  }
  return null
}

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
  sourceMissing = false,
  pxPerSec,
  onSelect,
  onOpen,
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
  /** This scene points at footage the project no longer lists. */
  sourceMissing?: boolean
  pxPerSec: number
  onSelect: (cut: WorkingCut) => void
  /** Double-click: seek to this scene and reveal it. Single click stays
   * select-only on purpose (owner, 2026-09-21 — grabbing a trim handle used
   * to jump the preview). */
  onOpen?: (cut: WorkingCut) => void
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
  const state = sceneStateOf(cut)
  const problem = sceneProblem(cut, sourceMissing, sourceDurationSec)
  const roomForBadges = widthPx >= BADGE_ROOM_PX

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
      onDoubleClick={() => onOpen?.(cut)}
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
        {/* The scene's own state, top-left over the footage. The problem
            marker is drawn even on a block too narrow for the rest — it is
            the one thing the user has to act on. */}
        {(problem ||
          (roomForBadges && (state.alternates > 0 || state.swapped || state.fromAi))) && (
          <span className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex items-center gap-0.5">
            {problem && (
              <span
                title={problem}
                className="pointer-events-auto flex items-center rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-error"
              >
                <AlertTriangle size={11} />
              </span>
            )}
            {roomForBadges && state.alternates > 0 && (
              <span
                title={`มีช็อตสำรอง ${state.alternates} ช็อต — เปิด "ปรับช็อต" เพื่อสลับ`}
                className="pointer-events-auto flex items-center gap-px rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-[10px] font-semibold leading-none tabular-nums text-ink"
              >
                <Repeat2 size={11} />
                {state.alternates}
              </span>
            )}
            {roomForBadges &&
              (state.swapped ? (
                <span
                  title="ช็อตนี้คุณเปลี่ยนเอง"
                  className="pointer-events-auto flex items-center rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-accent"
                >
                  <UserRoundPen size={11} />
                </span>
              ) : state.fromAi ? (
                <span
                  title="ช็อตนี้ AI เลือกให้"
                  className="pointer-events-auto flex items-center rounded-sm bg-[rgb(28_28_30_/_0.82)] px-0.5 py-px text-ink-3"
                >
                  <Sparkles size={11} />
                </span>
              ) : null)}
          </span>
        )}
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
