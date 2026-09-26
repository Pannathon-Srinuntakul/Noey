/**
 * Marquee selection and the reorder activator — pure, so the lane's pointer
 * plumbing stays a few lines and the rules are tested here.
 */

/** A rectangle in whatever coordinate space both sides agree on. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface IdRect extends Box {
  id: string
}

/** A Shift+drag that moved less than this is a click, not a marquee. */
export const MARQUEE_MIN_PX = 4

/** Two corners in any order → a box with left ≤ right and top ≤ bottom. A
 * drag up-and-left gives negative extents otherwise. */
export function normalizeBox(x0: number, y0: number, x1: number, y1: number): Box {
  return {
    left: Math.min(x0, x1),
    right: Math.max(x0, x1),
    top: Math.min(y0, y1),
    bottom: Math.max(y0, y1)
  }
}

/** True when the two boxes share any area (touching edges do not count). */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/**
 * Every rect the box INTERSECTS, in the order given — partial overlap selects
 * (Premiere / Resolve / Kdenlive), containment is not required. The box may be
 * given with its corners in any order.
 */
export function marqueeHits(rects: readonly IdRect[], box: Box): string[] {
  const b = normalizeBox(box.left, box.top, box.right, box.bottom)
  return rects.filter((r) => boxesIntersect(r, b)).map((r) => r.id)
}

/** The drag moved enough to be a marquee rather than a click. */
export function marqueeMoved(dx: number, dy: number, minPx = MARQUEE_MIN_PX): boolean {
  return Math.abs(dx) >= minPx || Math.abs(dy) >= minPx
}

/** The pointer event fields the reorder activator looks at. */
export interface ReorderPressEvent {
  altKey: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  button: number
  /** 'touch' presses are left to the long-press sensor. */
  pointerType?: string
  target: { closest(selector: string): unknown } | null
}

/**
 * Whether a press on a scene block may start a dnd-kit reorder.
 *
 * Not on Alt (that drag is a slip), not with Shift / ⌘ / Ctrl (a selection
 * gesture — and ⌘/Ctrl on a handle is a roll), not from a trim handle, not
 * from a secondary button, and not from a finger: touch goes through the
 * TouchSensor's long press so a swipe still scrolls.
 */
export function shouldStartReorder(ev: ReorderPressEvent): boolean {
  if (ev.button !== 0) return false
  if (ev.altKey || ev.shiftKey || ev.metaKey || ev.ctrlKey) return false
  if (ev.pointerType === 'touch') return false
  if (
    ev.target &&
    typeof ev.target.closest === 'function' &&
    ev.target.closest('[data-trim-handle]')
  ) {
    return false
  }
  return true
}
