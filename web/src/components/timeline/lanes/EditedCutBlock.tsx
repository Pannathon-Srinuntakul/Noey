import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, EyeOff, Repeat2, Sparkles, UserRoundPen } from 'lucide-react'
import { memo, useState } from 'react'
import { bindPointerDrag, type DragScroller } from '../../../lib/pointerDrag'
import { slipCut, type TrimEdge } from '../../../lib/timelineMath'
import type { FilmstripStrip } from '../../../lib/useFilmstripStrips'
import { FilmstripCanvas } from '../../FilmstripCanvas'
import { HEADER_COL_PX, IMG_LANE_PX, edgeZonePx } from '../constants'
import type { SnapContext, WorkingCut } from '../types'
import { DragReadout } from './DragReadout'
import {
  quantizeDeltaToFrame,
  rollReadoutText,
  sceneNoteOf,
  sceneTitleLine,
  sceneTooltip,
  selectModsOf,
  slipReadoutText,
  trimFrame,
  trimReadoutText,
  type SelectMods,
  type TrimReadout
} from './sceneLabel'
import { TrimBar } from './TrimBar'

export type { SelectMods, TrimReadout } from './sceneLabel'

/** Grabbable width for a scene block that is drawn narrower than this. It is an
 * overlay, never the block's own width — see EditedCutBlock. */
const MIN_BLOCK_HIT_PX = 14

/** Under this the block only has room for the problem marker. */
const BADGE_ROOM_PX = 38

/** The skipped stub's width — it overhangs a zero-width slot. */
const SKIP_STUB_PX = 12

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

/** What a live drag draws: its readout and which edge it hangs over. */
interface LiveDrag {
  kind: 'trim' | 'roll' | 'slip'
  edge: TrimEdge | null
  text: string
  atLimit: boolean
}

/**
 * Concatenated "edited" view of a scene: a cropped window of its source's full
 * filmstrip so scenes read as trimmed clips laid back-to-back, no gaps. The
 * whole block is draggable to reorder (R3: ลากตัวบล็อกเพื่อสลับลำดับ); its
 * edges trim (⌘/Ctrl on a handle rolls the boundary with the neighbour), and
 * Alt+drag on the body slips the window inside the footage.
 *
 * Every gesture is bracketed by onDragStart / onDragEnd (one history step),
 * and Escape restores the drag-start values BEFORE onDragEnd so the step
 * records no change.
 *
 * Memoized, and every callback takes the cut or its id, so the lane hands all
 * blocks the same functions: trimming one scene renders that block and the
 * ones after it (their start moved), not the ones before.
 */
export const EditedCutBlock = memo(function EditedCutBlock({
  cut,
  selected,
  multiSelected = false,
  focusedEdge = null,
  skipped = false,
  coarse = false,
  playOrder,
  sceneCount = 0,
  strip,
  pending = false,
  sourceDurationSec,
  sourceMissing = false,
  sourceLabel,
  pxPerSec,
  leadPx = 0,
  onSelect,
  onOpen,
  onContextMenu,
  onChange,
  onTrim,
  onRoll,
  onSlip,
  onFocusEdge,
  onDragStart,
  onDragEnd,
  startOffsetSec = 0,
  getSnapContext,
  dragScroller
}: {
  cut: WorkingCut
  pending?: boolean
  /** The primary selection — the inspector's scene. */
  selected: boolean
  /** In the selection but not primary (dashed border). */
  multiSelected?: boolean
  /** Which of this block's handles holds the roving focus. */
  focusedEdge?: TrimEdge | null
  /** The scene is skipped (meta.skipped): drawn as a zero-width stub so the
   * blocks after it stay aligned with the ruler. */
  skipped?: boolean
  /** A touch pointer — wider handles, and the block itself is `touch-none` so
   * a finger drag picks it up instead of scrolling. */
  coarse?: boolean
  playOrder: number
  /** How many scenes the lane has — a roll on the first scene's left handle or
   * the last scene's right one has no neighbour and is a plain trim. */
  sceneCount?: number
  strip: FilmstripStrip | null
  sourceDurationSec: number
  /** This scene points at footage the project no longer lists. */
  sourceMissing?: boolean
  /** The source clip's name for the tooltip. */
  sourceLabel?: string
  pxPerSec: number
  /** Padding before the axis (touch-scrub mode centres the playhead). */
  leadPx?: number
  onSelect: (cut: WorkingCut, mods: SelectMods) => void
  /** Double-click: seek to this scene and reveal it. Single click stays
   * select-only on purpose (owner, 2026-09-21 — grabbing a trim handle used
   * to jump the preview). */
  onOpen?: (cut: WorkingCut) => void
  onContextMenu?: (cut: WorkingCut, at: { x: number; y: number }) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  /** A trim-handle drag step: the cut as the drag found it, the edge, the
   * (snapped) patch, the in-point before this step — the parent keeps the
   * left edge under the pointer — and the readout. */
  onTrim: (
    cut: WorkingCut,
    edge: TrimEdge,
    patch: Partial<WorkingCut>,
    prevIn: number,
    readout: TrimReadout
  ) => void
  /** A roll step: this cut's boundary on `edge` moves by `deltaSec`
   * (drag-relative, frame-quantized) together with the neighbour's. 0 on
   * Escape restores. */
  onRoll?: (cutId: string, edge: TrimEdge, deltaSec: number) => void
  /** A slip step: the window moved inside the footage, length kept. */
  onSlip?: (cut: WorkingCut, patch: { in: number; out: number }) => void
  onFocusEdge?: (cutId: string, edge: TrimEdge | null) => void
  onDragStart: () => void
  onDragEnd: () => void
  /** This cut's start position on the output/edited timeline — trimming this
   * cut's edge only ever moves the boundary at startOffsetSec + durationSec. */
  startOffsetSec?: number
  /** The snap context — asked once, when a drag starts, and kept for the
   * whole drag (its isActive/tolSec/targets are read per frame). Passing the
   * targets as props rendered every block whenever anything moved. */
  getSnapContext: () => SnapContext
  /** Edge auto-scroll for a drag that leaves the viewport. */
  dragScroller?: DragScroller
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cut.id
  })
  const [live, setLive] = useState<LiveDrag | null>(null)
  const style = {
    // The origin slot stays put and dimmed while the DragOverlay ghost moves;
    // the neighbours still slide (their own transforms) to show the gap.
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : undefined,
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
  const widthPx = skipped ? 0 : durationSec * pxPerSec
  // The floor comes back as an OVERHANGING hit target instead — the same
  // pattern the music block, the VO blocks and the caption chips already use,
  // so a very short scene stays grabbable without moving its neighbours.
  const hitPadPx = !skipped && widthPx < MIN_BLOCK_HIT_PX ? MIN_BLOCK_HIT_PX : 0

  const maxOut = Math.max(sourceDurationSec, cut.out)
  const state = sceneStateOf(cut)
  const problem = sceneProblem(cut, sourceMissing, sourceDurationSec)
  const roomForBadges = widthPx >= BADGE_ROOM_PX
  const zonePx = edgeZonePx(widthPx, coarse)
  const titleLine = sceneTitleLine({
    playOrder,
    editedIn: startOffsetSec,
    durationSec,
    sourceLabel,
    sourceIn: cut.in
  })
  const title = sceneTooltip({
    playOrder,
    editedIn: startOffsetSec,
    durationSec,
    sourceLabel,
    sourceIn: cut.in,
    note: sceneNoteOf(cut)
  })

  /** The handle drag: a trim, or a roll with ⌘/Ctrl held (when there is a
   * neighbour on that side). */
  function onTrimDown(e: React.PointerEvent, edge: TrimEdge): void {
    if (e.button !== 0) return
    // A plain select: ⌘/Ctrl on a handle means roll, never toggle.
    onSelect(cut, { shift: false, toggle: false })
    const hasNeighbour =
      edge === 'left' ? playOrder > 1 : sceneCount === 0 || playOrder < sceneCount
    if ((e.metaKey || e.ctrlKey) && onRoll && hasNeighbour) {
      startRoll(e, edge)
      return
    }
    startTrim(e, edge)
  }

  function startTrim(e: React.PointerEvent, edge: TrimEdge): void {
    const ctx = getSnapContext()
    const startIn = cut.in
    const startOut = cut.out
    const startCut = cut
    // The in-point as of the previous drag step — `cut` is frozen at drag start.
    let lastIn = startIn
    onDragStart()
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        // Both asked per frame: Shift+N or Alt mid-drag must take effect, and
        // the binder's synthetic Alt frame lands without the mouse moving.
        const snapActive = ctx.isActive() && !f.altKey
        const r = trimFrame({
          edge,
          cut: startCut,
          startIn,
          startOut,
          minIn: 0,
          maxOut,
          deltaSec: f.deltaSec,
          snapActive,
          targets: snapActive ? ctx.outputTargets({ excludeCutId: startCut.id }) : [],
          tolSec: ctx.tolSec(),
          clock: 'output',
          startOffsetSec
        })
        ctx.report(r.hit, 'output')
        onTrim(startCut, edge, r.patch, lastIn, r.readout)
        if (r.patch.in !== undefined) lastIn = r.patch.in
        setLive({ kind: 'trim', edge, text: trimReadoutText(r.readout), atLimit: r.atLimit })
      },
      onEnd({ cancelled }) {
        // Restore BEFORE the bracket closes so the history step sees no change.
        if (cancelled) onChange(startCut.id, { in: startIn, out: startOut })
        ctx.report(null, 'output')
        setLive(null)
        onDragEnd()
      }
    })
  }

  function startRoll(e: React.PointerEvent, edge: TrimEdge): void {
    const id = cut.id
    onDragStart()
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const d = quantizeDeltaToFrame(f.deltaSec)
        onRoll?.(id, edge, d)
        setLive({ kind: 'roll', edge, text: rollReadoutText(d), atLimit: false })
      },
      onEnd({ cancelled }) {
        if (cancelled) onRoll?.(id, edge, 0)
        setLive(null)
        onDragEnd()
      }
    })
  }

  /** Alt+drag on the body: the window slides inside the footage, the block
   * stays where it is on the output clock — the R18b locked-regime move, by
   * hand. No snapping: nothing on the output clock moves. */
  function startSlip(e: React.PointerEvent): void {
    const startCut = cut
    const startIn = cut.in
    const startOut = cut.out
    const bounds = { minIn: 0, maxOut }
    onDragStart()
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const patch = slipCut(startCut, quantizeDeltaToFrame(f.deltaSec), bounds)
        if (onSlip) onSlip(startCut, patch)
        else onChange(startCut.id, patch)
        setLive({
          kind: 'slip',
          edge: null,
          text: slipReadoutText(patch.in - startIn),
          atLimit: false
        })
      },
      onEnd({ cancelled }) {
        if (cancelled) onChange(startCut.id, { in: startIn, out: startOut })
        setLive(null)
        onDragEnd()
      }
    })
  }

  const bodyCursor = sourceMissing
    ? 'cursor-not-allowed'
    : live?.kind === 'slip'
      ? 'cursor-ew-resize'
      : 'cursor-grab active:cursor-grabbing'
  const border = selected
    ? // 2px of accent, as a border plus an inset ring so the box does not
      // change size: outline, not colour alone, marks the primary scene.
      'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]'
    : multiSelected
      ? 'border-dashed border-accent'
      : 'border-border'

  const commonLi = {
    ...attributes,
    ...listeners,
    role: 'option' as const,
    'aria-selected': selected || multiSelected,
    'aria-label': titleLine,
    // Roving: the selected scene is the lane's one tab stop.
    tabIndex: selected ? 0 : -1,
    title,
    onPointerDown: (e: React.PointerEvent<HTMLLIElement>) => {
      if (e.button !== 0) return
      const onHandle = !!(e.target as Element | null)?.closest?.('[data-trim-handle]')
      if (onHandle) return
      // Selected on PRESS, like any editor — and before dnd-kit sees the
      // pointer, so a block picked up to reorder is the selected one.
      onSelect(cut, selectModsOf(e))
      if (e.altKey && !skipped) {
        // A slip, not a reorder — the sensor's activator declines Alt too.
        e.stopPropagation()
        startSlip(e)
        return
      }
      listeners?.onPointerDown?.(e)
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (!onContextMenu) return
      e.preventDefault()
      if (!selected && !multiSelected) onSelect(cut, { shift: false, toggle: false })
      onContextMenu(cut, { x: e.clientX, y: e.clientY })
    },
    onDoubleClick: () => onOpen?.(cut)
  }

  if (skipped) {
    // Zero width in flow so the ruler still lines up with the blocks after
    // it; the stub overhangs like the short-scene hit pad does.
    return (
      <li
        ref={setNodeRef}
        data-cut-block
        data-cut-id={cut.id}
        data-skipped
        style={{ ...style, width: 0 }}
        className={`relative h-full shrink-0 list-none focus-visible:outline-offset-[3px]! ${coarse ? 'touch-none' : ''}`}
        {...commonLi}
        title={`${titleLine}\nฉากนี้ถูกข้าม — กด D เพื่อเอากลับ`}
      >
        <span
          title="ฉากนี้ถูกข้าม — กด D เพื่อเอากลับ"
          className={`absolute inset-y-1 left-0 z-20 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded-sm border bg-[rgb(28_28_30_/_0.92)] text-muted ${
            selected ? 'border-accent' : 'border-border-strong'
          }`}
          style={{ width: SKIP_STUB_PX }}
        >
          <EyeOff size={9} />
        </span>
      </li>
    )
  }

  return (
    <li
      ref={setNodeRef}
      data-cut-block
      data-cut-id={cut.id}
      style={{ ...style, width: widthPx }}
      // A real focus ring (the global one), pushed 3px out so it reads as
      // focus and not as a second selection border. `touch-none` only on a
      // coarse pointer: a finger drag then picks the block up rather than
      // scrolling the viewport — a swipe on the lane BACKGROUND still scrolls.
      className={`relative flex h-full shrink-0 list-none items-end focus-visible:outline-offset-[3px]! ${
        coarse ? 'touch-none' : ''
      }`}
      {...commonLi}
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
        className={`group absolute inset-0 overflow-hidden rounded-[5px] border bg-black transition-[filter] duration-state hover:brightness-110 ${bodyCursor} ${border}`}
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
          laneLeftPx={HEADER_COL_PX + leadPx + startOffsetSec * pxPerSec}
          pxPerSec={pxPerSec}
          opacity={0.6}
        />
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
        {(selected || zonePx > 0) && (
          <>
            <TrimBar
              edge="left"
              visible={selected}
              zonePx={zonePx}
              sceneNumber={playOrder}
              min={0}
              max={cut.out}
              value={cut.in}
              focused={focusedEdge === 'left'}
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
              focused={focusedEdge === 'right'}
              atLimit={live?.edge === 'right' && live.atLimit}
              cutId={cut.id}
              onTrimDown={onTrimDown}
              onFocusEdge={onFocusEdge}
            />
          </>
        )}
      </div>
      {/* The play-order label is OUTSIDE the clipped inner div and sticky at
          the header column's edge, so a block half scrolled under the track
          names still says which scene it is (Premiere / Resolve / FCP pin the
          label). In flow — sticky needs that — and never a pointer target. */}
      <span
        aria-hidden
        className="pointer-events-none sticky z-20 pb-0.5 pl-1.5 text-[13px] font-semibold tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]"
        style={{ left: HEADER_COL_PX + 4 }}
      >
        {playOrder}
      </span>
      {live && (
        <DragReadout
          text={live.text}
          anchor={live.edge ?? 'center'}
          tone={live.atLimit ? 'limit' : 'default'}
        />
      )}
    </li>
  )
})
