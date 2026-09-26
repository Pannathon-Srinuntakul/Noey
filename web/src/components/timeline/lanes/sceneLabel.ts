/**
 * Lane pure helpers — every piece of lane arithmetic and wording that does not
 * need a DOM, so the lanes' components stay thin and this file carries the
 * tests (Vitest here runs without jsdom).
 *
 * Wording lives here too: the drag readouts, the scene tooltip and the reorder
 * hint are the lanes' "show me what is happening" channel, and a string built
 * in three components drifts three ways.
 */
import type { EditCut } from '../../../lib/editorApi'
import {
  MIN_CUT_SEC,
  clamp,
  fmtFrames,
  fmtSignedSec,
  fmtTimeTenths,
  type TrimEdge
} from '../../../lib/timelineMath'
import {
  quantizeToFrame,
  snapTrimPatch,
  type SnapHit,
  type SnapTarget
} from '../../../lib/timelineSnap'
import type { FilmstripStrip } from '../../../lib/useFilmstripStrips'
import { IS_MAC } from '../shortcuts'

/** What a trim-handle drag tells the parent (and draws in its readout). */
export interface TrimReadout {
  /** How far the dragged edge moved from where the drag found it, in seconds. */
  deltaSec: number
  /** The scene's length after this step. */
  durationSec: number
  /** The edge is pinned at the end of the footage — FCP's red edge. */
  atLimit: boolean
}

/** Selection modifiers a block press carries to the editor's reducer. */
export interface SelectMods {
  shift: boolean
  toggle: boolean
}

/** The selection modifiers of a press: Shift = range, ⌘ (Mac) / Ctrl = toggle. */
export function selectModsOf(e: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}): SelectMods {
  return { shift: e.shiftKey, toggle: IS_MAC ? e.metaKey : e.ctrlKey }
}

// ---- readouts --------------------------------------------------------------

/** fmtTimeTenths floors, and 15.2 is 15.199999… once it has been through an
 * addition — a hair of slack so an exact tenth reads as itself. */
function fmtTenths(sec: number): string {
  return fmtTimeTenths(sec + 1e-6)
}

/** 'ยาว 2.10 วิ' — two decimals: the readout is where frames matter. */
function fmtLength(sec: number): string {
  return `ยาว ${Math.max(sec, 0).toFixed(2)} วิ`
}

/** '+0.40 วิ (+12 เฟรม) · ยาว 2.10 วิ', plus ' · หมดฟุตเทจ' at the footage end. */
export function trimReadoutText(r: TrimReadout): string {
  const base = `${fmtSignedSec(r.deltaSec)} (${fmtFrames(r.deltaSec)}) · ${fmtLength(r.durationSec)}`
  return r.atLimit ? `${base} · หมดฟุตเทจ` : base
}

/** Alt+drag on the block body, or a move in the source view: the window slides
 * inside the footage. */
export function slipReadoutText(deltaSec: number): string {
  return `เลื่อนหน้าต่าง ${fmtSignedSec(deltaSec)}`
}

/** ⌘/Ctrl+drag on a handle: the boundary between two scenes moves. */
export function rollReadoutText(deltaSec: number): string {
  return `เลื่อนรอยตัด ${fmtSignedSec(deltaSec)}`
}

/** The music block's move: where the track now starts on the output clock. */
export function musicReadoutText(offsetSec: number): string {
  return `เริ่มที่ ${fmtTenths(offsetSec)}`
}

// ---- scene tooltip -----------------------------------------------------------

export interface SceneTooltipInput {
  playOrder: number
  /** The scene's start on the edited clock. */
  editedIn: number
  durationSec: number
  /** The source clip's name as the user knows it — omitted when unknown. */
  sourceLabel?: string
  /** The scene's in-point inside its source. */
  sourceIn: number
  /** The AI's one-line note on why this shot (an alternate's note or the
   * visual description) — the one place it is shown. */
  note?: string | null
}

/** 'ฉาก 3 · 0:12.0–0:15.2 · จากคลิป B ที่ 0:41.0' — the line a screen reader
 * gets as the block's name. */
export function sceneTitleLine(s: SceneTooltipInput): string {
  const span = `${fmtTenths(s.editedIn)}–${fmtTenths(s.editedIn + s.durationSec)}`
  const from = s.sourceLabel
    ? `จากคลิป ${s.sourceLabel} ที่ ${fmtTenths(s.sourceIn)}`
    : `ต้นฉบับที่ ${fmtTenths(s.sourceIn)}`
  return `ฉาก ${s.playOrder} · ${span} · ${from}`
}

/** The title line plus the AI note on a second line when there is one. */
export function sceneTooltip(s: SceneTooltipInput): string {
  const line = sceneTitleLine(s)
  const note = s.note?.trim()
  return note ? `${line}\n${note}` : line
}

/** The AI note for a cut, if its meta carries one — an alternate's note first
 * (it is written about THIS pick), the visual description otherwise. */
export function sceneNoteOf(cut: Pick<EditCut, 'meta'>): string | null {
  const meta = cut.meta
  if (!meta) return null
  const alts = meta.alternates
  if (Array.isArray(alts) && alts.length > 0) {
    const first = alts[0] as { note?: unknown } | null
    if (first && typeof first.note === 'string' && first.note.trim()) return first.note
  }
  const desc = meta.visualDescription
  return typeof desc === 'string' && desc.trim() ? desc : null
}

// ---- reorder ghost caption ---------------------------------------------------

/**
 * Where a dragged scene would land: 'ก่อนฉาก N' or 'ท้ายสุด'.
 *
 * `overIndex` is the slot dnd-kit reports; a scene dragged FORWARD lands after
 * the block it is over (arrayMove semantics), so the hint names the block
 * after that one.
 */
export function reorderHint(overIndex: number, count: number, activeIndex = -1): string {
  if (count <= 0 || overIndex < 0) return ''
  if (activeIndex >= 0 && activeIndex === overIndex) return 'ตำแหน่งเดิม'
  const landsAfterOver = activeIndex >= 0 && activeIndex < overIndex
  const beforeIndex = landsAfterOver ? overIndex + 1 : overIndex
  if (beforeIndex >= count) return 'ท้ายสุด'
  return `ก่อนฉาก ${beforeIndex + 1}`
}

// ---- trim arithmetic -----------------------------------------------------------

/** A SIGNED drag delta on the frame grid — quantizeToFrame floors at 0, which
 * is right for a time and wrong for a roll or slip dragged leftwards. */
export function quantizeDeltaToFrame(deltaSec: number): number {
  const q = quantizeToFrame(Math.abs(deltaSec))
  if (q === 0) return 0
  return deltaSec < 0 ? -q : q
}

export interface TrimFrameInput {
  edge: TrimEdge
  /** The cut as the drag found it — `in`/`out` are the drag-start values. */
  cut: EditCut
  startIn: number
  startOut: number
  /** The footage limits: 0 / the source length in the edited view, the lane
   * neighbours in the source view. */
  minIn: number
  maxOut: number
  deltaSec: number
  /** Snap is on AND Alt is not held (asked per frame, so a toggle mid-drag
   * takes effect). */
  snapActive: boolean
  targets: readonly SnapTarget[]
  tolSec: number
  clock: 'output' | 'source'
  /** The cut's start on the output clock (edited view only). */
  startOffsetSec: number
}

export interface TrimFrameResult {
  patch: Partial<Pick<EditCut, 'in' | 'out'>>
  hit: SnapHit | null
  /** The raw value ran into the footage end (minIn / maxOut) — not the
   * MIN_CUT_SEC floor, which is a scene-length rule, not a footage limit. */
  atLimit: boolean
  readout: TrimReadout
}

/**
 * One trim-drag frame: quantize to a frame, clamp as bindTrimDrag did, snap
 * (the snap engine clamps again and drops the hit when the clamp moved it).
 *
 * Quantize BEFORE snapping so a snap target — exact by definition — wins over
 * the frame grid rather than being rounded off it.
 */
export function trimFrame(a: TrimFrameInput): TrimFrameResult {
  const { edge, startIn, startOut, minIn, maxOut, deltaSec } = a
  let raw: Partial<Pick<EditCut, 'in' | 'out'>>
  let atLimit: boolean
  // The limit is judged on the unquantized value: quantizeToFrame floors at
  // 0, which would hide a drag past the start of the footage.
  if (edge === 'left') {
    const wanted = startIn + deltaSec
    atLimit = wanted < minIn - 1e-9
    raw = { in: clamp(quantizeToFrame(wanted), minIn, startOut - MIN_CUT_SEC) }
  } else {
    const wanted = startOut + deltaSec
    atLimit = wanted > maxOut + 1e-9
    raw = { out: clamp(quantizeToFrame(wanted), startIn + MIN_CUT_SEC, maxOut) }
  }
  const cut = { ...a.cut, in: startIn, out: startOut }
  // The context already drops this cut's own boundaries; filtered again here
  // so a caller that forgot cannot snap a scene onto itself.
  const targets = a.targets.filter((t) => t.ownerId !== cut.id)
  const snapped = a.snapActive
    ? snapTrimPatch({
        patch: raw,
        cut,
        edge,
        clock: a.clock,
        startOffsetSec: a.startOffsetSec,
        minIn,
        maxOut,
        targets,
        tolSec: a.tolSec
      })
    : { patch: raw, hit: null }
  const nextIn = snapped.patch.in ?? startIn
  const nextOut = snapped.patch.out ?? startOut
  const moved = edge === 'left' ? nextIn - startIn : nextOut - startOut
  return {
    patch: snapped.patch,
    hit: snapped.hit,
    atLimit,
    readout: { deltaSec: moved, durationSec: nextOut - nextIn, atLimit }
  }
}

// ---- music snap choice -----------------------------------------------------------

export interface MusicSnapChoice {
  offsetSec: number
  /** The edge hit when the span snap won — the beat snap has no single target
   * to draw a guide at (it aligns a beat with a cut, not the block's edge). */
  hit: SnapHit | null
  /** The beat-on-cut alignment won. */
  beat: boolean
}

/**
 * Two candidate snaps for a music move — the block's edges against the output
 * targets, and a beat onto a cut — take whichever moved the block LESS. A
 * candidate that did not move the block (no hit / the same offset) is not in
 * the running.
 */
export function pickMusicSnap(
  rawOffset: number,
  span: { start: number; hit: SnapHit | null },
  beatOffset: number | null
): MusicSnapChoice {
  const spanMove = span.hit ? Math.abs(span.start - rawOffset) : Infinity
  const beatMove =
    beatOffset !== null && Math.abs(beatOffset - rawOffset) > 1e-9
      ? Math.abs(beatOffset - rawOffset)
      : Infinity
  if (spanMove === Infinity && beatMove === Infinity) {
    return { offsetSec: rawOffset, hit: null, beat: false }
  }
  if (beatMove < spanMove) return { offsetSec: beatOffset as number, hit: null, beat: true }
  return { offsetSec: span.start, hit: span.hit, beat: false }
}

// ---- scene strip thumbnails --------------------------------------------------------

/** The strip tile that shows `sec` of the source — the same rounding the
 * filmstrip lanes use for a slot centre — or null when there is no strip. */
export function stripTileFor(
  strip: Pick<FilmstripStrip, 'count' | 'tileSec'> | null | undefined,
  sec: number
): number | null {
  if (!strip || strip.count <= 0 || strip.tileSec <= 0) return null
  const idx = Math.round(Math.max(sec, 0) / strip.tileSec - 0.5)
  return Math.min(strip.count - 1, Math.max(0, idx))
}
