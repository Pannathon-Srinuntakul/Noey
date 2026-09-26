import { clamp } from '../../lib/timelineMath'
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './constants'

/**
 * The viewport's arithmetic — zoom anchoring, fit, range zoom, pinch, drag
 * auto-scroll, the off-screen playhead hint and the touch-scrub model — kept
 * out of useTimelineViewport so it can be tested without a DOM.
 *
 * Coordinates: the scroll container's CONTENT puts time `t` at
 * `headerColPx + leadPx + t · pxPerSec`; the sticky label column covers the
 * first `headerColPx` of the VIEWPORT, so a viewport x is
 * `contentX − scrollLeft`. `leadPx` is the touch-scrub lead (see leadPxFor),
 * zero on desktop.
 */

/**
 * scrollLeft that puts `anchorSec` back under viewport x `pointerVX` once the
 * zoom is `nextPxPerSec` — the time under the pointer (or the playhead, or
 * the centre) stays put while everything else stretches around it.
 */
export function anchoredScrollLeft(
  anchorSec: number,
  nextPxPerSec: number,
  pointerVX: number,
  headerColPx: number,
  leadPx = 0
): number {
  return Math.max(0, headerColPx + leadPx + anchorSec * nextPxPerSec - pointerVX)
}

/** The zoom at which `durSec` fills the viewport, leaving `tailPx` of room past
 * the end. Never below 120 px of usable width so a tiny viewport still zooms
 * sanely. */
export function fitPxPerSec(
  clientWidth: number,
  durSec: number,
  headerColPx: number,
  tailPx: number,
  minPx = MIN_PX_PER_SEC,
  maxPx = MAX_PX_PER_SEC
): number {
  if (!(durSec > 0)) return minPx
  const usable = Math.max(clientWidth - headerColPx - tailPx, 120)
  return clamp(usable / durSec, minPx, maxPx)
}

/**
 * Zoom so `[inSec, outSec]` fills the drawable width minus `padPx` on each
 * side, and the scrollLeft that puts `inSec` at the left pad. The zoom is
 * clamped, so a very short or very long range may not fill the width — the
 * range still starts at the pad.
 */
export function rangeZoom(
  inSec: number,
  outSec: number,
  clientWidth: number,
  headerColPx: number,
  padPx: number,
  minPx = MIN_PX_PER_SEC,
  maxPx = MAX_PX_PER_SEC,
  leadPx = 0
): { pxPerSec: number; scrollLeft: number } {
  const span = Math.max(outSec - inSec, 1e-6)
  const avail = Math.max(clientWidth - headerColPx - 2 * padPx, 1)
  const pxPerSec = clamp(avail / span, minPx, maxPx)
  const scrollLeft = Math.max(0, leadPx + inSec * pxPerSec - padPx)
  return { pxPerSec, scrollLeft }
}

/** Zoom factor of a two-finger pinch: the finger distance now over the
 * distance when the gesture began. A degenerate start (both fingers on the
 * same point) zooms by nothing. */
export function pinchFactor(d0: number, d1: number): number {
  if (!(d0 > 0) || !Number.isFinite(d1)) return 1
  return d1 / d0
}

/** The time at the centre of the drawable part of the viewport (the part not
 * under the sticky label column). */
export function centreTime(
  scrollLeft: number,
  clientWidth: number,
  pxPerSec: number,
  headerColPx: number,
  leadPx = 0
): number {
  const drawable = Math.max(clientWidth - headerColPx, 0)
  const contentX = scrollLeft + headerColPx + drawable / 2
  return Math.max(0, (contentX - headerColPx - leadPx) / Math.max(pxPerSec, 1e-6))
}

/**
 * How far to scroll this frame for a drag whose pointer is at `clientX`:
 * nothing while the pointer is more than `edgePx` inside either edge of the
 * drawable panel (`leftEdge`..`rightEdge`, in client px), ramping
 * quadratically to `maxPx` at the edge itself — and staying at `maxPx` past
 * it, since a drag can leave the panel. Negative scrolls left. Zero when the
 * panel is already scrolled to that end (`scrollLeft` / `maxScrollLeft`).
 */
export function autoScrollStep(
  clientX: number,
  leftEdge: number,
  rightEdge: number,
  edgePx: number,
  maxPx: number,
  scrollLeft?: number,
  maxScrollLeft?: number
): number {
  if (!(edgePx > 0) || !(maxPx > 0) || rightEdge <= leftEdge) return 0
  const fromLeft = clientX - leftEdge
  const fromRight = rightEdge - clientX
  let step = 0
  if (fromLeft < edgePx && fromLeft <= fromRight) {
    const p = clamp((edgePx - fromLeft) / edgePx, 0, 1)
    step = -maxPx * p * p
  } else if (fromRight < edgePx) {
    const p = clamp((edgePx - fromRight) / edgePx, 0, 1)
    step = maxPx * p * p
  }
  if (step < 0 && scrollLeft !== undefined && scrollLeft <= 0) return 0
  if (step > 0 && scrollLeft !== undefined && maxScrollLeft !== undefined) {
    if (scrollLeft >= maxScrollLeft) return 0
  }
  return step
}

/**
 * Which side the playhead ran off, using the same margins as
 * followScrollLeft (previewMath): 'left' when it is under or left of the
 * label column, 'right' when it is past the right edge, null when on screen.
 */
export function edgeHint(
  playheadX: number,
  scrollLeft: number,
  clientWidth: number,
  headerColPx: number
): 'left' | 'right' | null {
  const leftEdge = scrollLeft + headerColPx + 16
  const rightEdge = scrollLeft + clientWidth - 48
  if (playheadX < leftEdge) return 'left'
  if (playheadX > rightEdge) return 'right'
  return null
}

// ---- touch-scrub model (phone width: fixed playhead, strip scrolls) -------

/** scrollLeft that puts time `t` under the pinned playhead. With the lead
 * padding of leadPxFor, the head sits at the viewport centre at every t. */
export function centredScrollLeft(t: number, pxPerSec: number): number {
  return Math.max(0, t * pxPerSec)
}

/** The inverse: the time under the pinned playhead for a scrollLeft — what a
 * finger swipe on the strip scrubs to. */
export function timeFromScroll(scrollLeft: number, pxPerSec: number): number {
  return Math.max(0, scrollLeft / Math.max(pxPerSec, 1e-6))
}

/** Padding before time 0 so the pinned playhead can sit at the viewport
 * centre with the start of the clip under it. Zero on desktop, where the
 * playhead moves and the timeline stays. */
export function leadPxFor(clientWidth: number, headerColPx: number, touchScrub: boolean): number {
  if (!touchScrub) return 0
  return Math.max(0, Math.round(clientWidth / 2) - headerColPx)
}

/** The scene-block flash ring. Empty under prefers-reduced-motion: the block
 * is still scrolled into view, it just does not pulse. */
export function flashKeyframes(reduced: boolean): Keyframe[] {
  if (reduced) return []
  return [
    { boxShadow: '0 0 0 0 rgb(217 164 65 / 0)' },
    { boxShadow: '0 0 0 3px rgb(217 164 65 / 0.9)' },
    { boxShadow: '0 0 0 0 rgb(217 164 65 / 0)' }
  ]
}
