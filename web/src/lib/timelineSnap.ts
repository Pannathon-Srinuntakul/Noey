/**
 * Snap engine for the timeline editor (editor-standard pass, 2026-09-27).
 *
 * Pure: no React, no DOM. Every drag in the editor — trim, slip, music move,
 * marker move, scrub — runs its candidate through here so the magnet feels the
 * same everywhere. The tolerance is SCREEN pixels converted to seconds at the
 * current zoom (`snapTolSec`); the fixed 0.2 s of the old beat snap was 32 px
 * zoomed in and under a pixel zoomed out.
 *
 * Targets are plain `{ sec, kind }` values the caller assembles
 * (`components/timeline/snapTargets.ts`): cut edges, the playhead, voiceover
 * line boundaries, captions, music edges, beats, markers, the I/O range, and
 * the sequence start/end. Beats are handed in already converted to output
 * seconds (`beat − musicTrimInSec + musicOffsetSec`).
 */
import { FRAME_SEC, SNAP_THRESHOLD_PX } from '../components/timeline/constants'
import type { EditCut } from './editorApi'
import { MIN_CUT_SEC, clamp } from './timelineMath'

export { SNAP_THRESHOLD_PX }

export type SnapKind =
  | 'start'
  | 'cut'
  | 'playhead'
  | 'voiceover'
  | 'caption'
  | 'music'
  | 'beat'
  | 'marker'
  | 'range'
  | 'end'

export interface SnapTarget {
  sec: number
  kind: SnapKind
  /** The cut / marker the target belongs to, so a drag can exclude its own edges. */
  ownerId?: string
}

export interface SnapHit {
  target: SnapTarget
  /** Signed: target − candidate. */
  distSec: number
}

/** Snap tolerance in seconds for a pull of `thresholdPx` screen px at this zoom. */
export function snapTolSec(pxPerSec: number, thresholdPx = SNAP_THRESHOLD_PX): number {
  return thresholdPx / Math.max(pxPerSec, 1)
}

/**
 * The closest target strictly inside `tolSec` of `candidate`, or null.
 * Ties go to the EARLIER target in the list (callers list them in time order,
 * so the earlier time wins). `exclude` drops targets a drag must not see —
 * a cut's own two edges, a marker's own position.
 */
export function nearestTarget(
  candidate: number,
  targets: readonly SnapTarget[],
  tolSec: number,
  exclude?: (t: SnapTarget) => boolean
): SnapHit | null {
  let best: SnapHit | null = null
  for (const t of targets) {
    if (exclude && exclude(t)) continue
    const dist = t.sec - candidate
    const abs = Math.abs(dist)
    if (abs >= tolSec) continue
    if (!best || abs < Math.abs(best.distSec)) best = { target: t, distSec: dist }
  }
  return best
}

/** Round to the nearest frame, never below 0, rounded to 1e-6 so a frame
 * multiple compares equal to the literal a test (or a saved script) holds. */
export function quantizeToFrame(sec: number, frameSec = FRAME_SEC): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0
  const q = Math.round(sec / frameSec) * frameSec
  return Math.round(q * 1e6) / 1e6
}

/**
 * What a lane reads at pointerdown and then queries EVERY frame — `isActive`
 * and `tolSec` are live so Alt held / Shift+N mid-drag take effect without
 * moving the mouse. `report` paints (or clears) the guide line.
 */
export interface SnapContext {
  isActive(): boolean
  tolSec(): number
  outputTargets(opts?: { excludeCutId?: string }): SnapTarget[]
  sourceTargets(sourceId: string, opts?: { excludeCutId?: string }): SnapTarget[]
  report(hit: SnapHit | null, clock: 'output' | 'source'): void
}

/** A context that never snaps — for tests and for lanes mounted without an editor. */
export const NO_SNAP: SnapContext = {
  isActive: () => false,
  tolSec: () => 0,
  outputTargets: () => [],
  sourceTargets: () => [],
  report: () => {}
}

export interface SnapTrimPatchInput {
  patch: Partial<Pick<EditCut, 'in' | 'out'>>
  cut: EditCut
  edge: 'left' | 'right'
  /** 'output': targets are on the sequence clock; 'source': on the file's clock. */
  clock: 'output' | 'source'
  /** Where the block starts on the output clock (sum of the cuts before it). */
  startOffsetSec: number
  minIn: number
  maxOut: number
  targets: readonly SnapTarget[]
  tolSec: number
}

/**
 * Snap a trim patch to the nearest target, then put it back inside its bounds.
 *
 * ORDER MATTERS (copied from `snapTrimToBeat`): the caller quantizes and clamps
 * first, but a snap can push the value straight back out, and nothing
 * downstream re-checks — a right-edge snap could leave a scene a few frames
 * long, a left-edge snap a negative `in` that silently offsets every later
 * scene. So: snap, clamp, and if the clamp moved the snapped value the snap
 * did not take — return `hit: null` so no guide line is drawn for it.
 *
 * On the OUTPUT clock only the block's END lands on a new position when it is
 * trimmed — its start is pinned by the cuts before it — so whichever edge is
 * dragged, it is the END that is measured against the targets. On the SOURCE
 * clock the dragged edge itself is the candidate.
 */
export function snapTrimPatch(a: SnapTrimPatchInput): {
  patch: Partial<Pick<EditCut, 'in' | 'out'>>
  hit: SnapHit | null
} {
  const { patch, cut, edge, clock, startOffsetSec, minIn, maxOut, targets, tolSec } = a

  if (edge === 'right') {
    if (patch.out === undefined) return { patch, hit: null }
    const lo = cut.in + MIN_CUT_SEC
    const hi = maxOut
    const candidate = clock === 'output' ? startOffsetSec + (patch.out - cut.in) : patch.out
    const hit = nearestTarget(candidate, targets, tolSec)
    if (!hit) return { patch: { out: clamp(patch.out, lo, hi) }, hit: null }
    const snapped = clock === 'output' ? cut.in + (hit.target.sec - startOffsetSec) : hit.target.sec
    const out = clamp(snapped, lo, hi)
    return { patch: { out }, hit: out === snapped ? hit : null }
  }

  if (patch.in === undefined) return { patch, hit: null }
  const lo = minIn
  const hi = cut.out - MIN_CUT_SEC
  const candidate = clock === 'output' ? startOffsetSec + (cut.out - patch.in) : patch.in
  const hit = nearestTarget(candidate, targets, tolSec)
  if (!hit) return { patch: { in: clamp(patch.in, lo, hi) }, hit: null }
  const snapped = clock === 'output' ? cut.out - (hit.target.sec - startOffsetSec) : hit.target.sec
  const inSec = clamp(snapped, lo, hi)
  return { patch: { in: inSec }, hit: inSec === snapped ? hit : null }
}

/**
 * Snap a span whose start and end move TOGETHER (a slipped source window, a
 * moved music block): both edges are measured, the nearer hit wins, both
 * shift by the same amount, then the span is clamped to
 * [minStart, maxEnd − length]. `hit` is null when the clamp moved it.
 */
export function snapSpan(a: {
  start: number
  end: number
  minStart: number
  maxEnd: number
  targets: readonly SnapTarget[]
  tolSec: number
}): { start: number; end: number; hit: SnapHit | null } {
  const { start, end, minStart, maxEnd, targets, tolSec } = a
  const len = end - start
  const hitStart = nearestTarget(start, targets, tolSec)
  const hitEnd = nearestTarget(end, targets, tolSec)
  let hit: SnapHit | null = null
  if (hitStart && hitEnd) {
    hit = Math.abs(hitEnd.distSec) < Math.abs(hitStart.distSec) ? hitEnd : hitStart
  } else {
    hit = hitStart ?? hitEnd
  }
  const snappedStart = start + (hit ? hit.distSec : 0)
  const hiStart = Math.max(minStart, maxEnd - len)
  const s = clamp(snappedStart, minStart, hiStart)
  return { start: s, end: s + len, hit: hit && s === snappedStart ? hit : null }
}

/** Snap a scrub / playhead candidate; no bounds here (the caller clamps to the duration). */
export function snapScrub(
  candidate: number,
  targets: readonly SnapTarget[],
  tolSec: number
): { sec: number; hit: SnapHit | null } {
  const hit = nearestTarget(candidate, targets, tolSec)
  return { sec: hit ? hit.target.sec : candidate, hit }
}
