import type { SnapHit, SnapTarget } from '../../lib/timelineSnap'
import { FRAME_SEC } from './constants'
import type { WorkingCut } from './types'

/**
 * The player's decisions that do not need a <video>: when a play range ends
 * (and whether it loops), what "play around the cut" spans, which range a
 * scene is, whether the hover skimmer may run, whether a scrub snaps, and
 * which frame goes to which side of the two-up preview.
 */

/** A range the player stops at (or loops inside). On the active view's
 * clock: the edited sequence, or the file's own in the source view. */
export interface PlayRange {
  in: number
  out: number
  /** Loop this range regardless of the global loop switch. */
  loop?: boolean
}

/**
 * What to do with the range once playback reaches `t`: nothing while inside
 * it, 'restart' (seek back to `in`, keep playing) when it loops, else 'stop'
 * (pause at `out`, clear the range). Half a frame of slack: the frame loop
 * reads the element once per frame and would otherwise overshoot by one.
 */
export function rangeStop(
  t: number,
  range: PlayRange,
  loop: boolean,
  frameSec = FRAME_SEC
): 'stop' | 'restart' | null {
  if (t < range.out - frameSec / 2) return null
  return loop || range.loop ? 'restart' : 'stop'
}

/** ±N seconds around a moment, clamped to the clip. A moment at the very
 * start or end still yields a playable range on the side that exists. */
export function playAroundRange(
  sec: number,
  durSec: number,
  preSec: number,
  postSec: number
): PlayRange {
  const dur = Math.max(durSec, 0)
  const start = Math.max(0, Math.min(sec - preSec, dur))
  const end = Math.max(start, Math.min(dur, sec + postSec))
  return { in: start, out: end }
}

/**
 * The range a scene occupies on the active view's clock: its edited span in
 * the edited view (null when it has no segment — a skipped scene), or its
 * in/out on its own file in the source view.
 */
export function sceneRange(
  cutId: string,
  cuts: readonly WorkingCut[],
  editedInById: ReadonlyMap<string, number>,
  viewMode: 'source' | 'edited'
): (PlayRange & { source: string }) | null {
  const cut = cuts.find((c) => c.id === cutId)
  if (!cut) return null
  if (viewMode === 'source') return { in: cut.in, out: cut.out, source: cut.source }
  const editedIn = editedInById.get(cutId)
  if (editedIn === undefined) return null
  return { in: editedIn, out: editedIn + (cut.out - cut.in), source: cut.source }
}

/** Whether hovering the timeline may move the preview: never over a moving
 * or busy player — playing, scrubbing, a block drag, a file swap — and only
 * when the user has the skimmer on. */
export function canSkim({
  playing,
  scrubbing,
  editing,
  swapPending,
  enabled
}: {
  playing: boolean
  scrubbing: boolean
  editing: boolean
  swapPending: boolean
  enabled: boolean
}): boolean {
  return enabled && !playing && !scrubbing && !editing && !swapPending
}

export interface ScrubSnapMods {
  /** The snap context is on (toggle on, Alt not held). */
  active: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Nearest target strictly inside the tolerance, ties to the earlier one —
 * the same rule as the trim snap (lib/timelineSnap). Used when the caller
 * hands no snapper in. */
function nearestScrubSnap(
  candidate: number,
  targets: readonly SnapTarget[],
  tolSec: number
): { sec: number; hit: SnapHit | null } {
  let best: SnapHit | null = null
  for (const target of targets) {
    const distSec = Math.abs(target.sec - candidate)
    if (distSec >= tolSec) continue
    if (
      !best ||
      distSec < best.distSec ||
      (distSec === best.distSec && target.sec < best.target.sec)
    ) {
      best = { target, distSec }
    }
  }
  return best ? { sec: best.target.sec, hit: best } : { sec: candidate, hit: null }
}

/**
 * Whether a scrub frame snaps, and to what. Alt (the universal snap
 * suppressor) and Shift (frame-precise scrubbing, the FCP/Resolve habit)
 * both bypass it; an inactive context does too. `snap` is the snapper to
 * apply — the player passes lib/timelineSnap's snapScrub.
 */
export function scrubSnapDecision(
  t: number,
  mods: ScrubSnapMods,
  targets: readonly SnapTarget[],
  tolSec: number,
  snap: (
    candidate: number,
    targets: readonly SnapTarget[],
    tolSec: number
  ) => { sec: number; hit: SnapHit | null } = nearestScrubSnap
): { sec: number; hit: SnapHit | null } {
  if (!mods.active || mods.altKey || mods.shiftKey) return { sec: t, hit: null }
  return snap(t, targets, tolSec)
}

/** The last frame of a scene is shown a hair before its out-point: the
 * out-point itself is the first frame that is NOT in the scene. */
export const TWO_UP_TAIL_SEC = 0.04

/**
 * Which source-local second each side of the two-up viewer shows.
 *
 * A roll moves one junction: `out` is the left scene's new out-point and
 * `in` the right scene's new in-point, so the left pane shows the outgoing
 * last frame and the right pane the incoming first frame. A slip moves one
 * scene's window: `in`/`out` are that scene's new bounds, so the left pane
 * shows its new first frame and the right pane its new last frame.
 */
export function twoUpTimes(
  kind: 'roll' | 'slip',
  patch: { in: number; out: number }
): { leftSec: number; rightSec: number } {
  if (kind === 'roll') {
    return { leftSec: Math.max(0, patch.out - TWO_UP_TAIL_SEC), rightSec: patch.in }
  }
  return {
    leftSec: patch.in,
    rightSec: Math.max(patch.in, patch.out - TWO_UP_TAIL_SEC)
  }
}
