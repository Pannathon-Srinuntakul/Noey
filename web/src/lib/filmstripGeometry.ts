/**
 * Pure geometry for the canvas filmstrip lanes.
 *
 * Ported from FreeCut (MIT, walterlow/freecut,
 * `clip-filmstrip/render-window.ts` and `clip-filmstrip/filmstrip-canvas-geometry.ts`)
 * and adapted to this editor's model: our timeline's axis is SECONDS at
 * `pxPerSec`, not frames at a project fps, and a lane draws one source clip
 * from `sourceStartSec` rather than a trimmed item with speed and reversal.
 *
 * Everything here is a pure function of numbers so it can be unit-tested
 * without a canvas — the same split `timelineMath.ts` already uses.
 */

/** Which slice of a lane is worth painting, in lane-local pixels. */
export interface FilmstripWindow {
  /** Lane width in CSS px at the current zoom. */
  renderWidth: number
  visibleStartPx: number
  visibleEndPx: number
}

export interface FilmstripWindowInput {
  /** Where the lane starts inside the scrolling content, in px. */
  laneLeftPx: number
  /** Lane width in px at the current zoom. */
  laneWidthPx: number
  /** The scroll container's current `scrollLeft`. */
  scrollLeft: number
  /** The scroll container's `clientWidth`. */
  viewportWidth: number
  /** Extra px painted either side of the viewport so a small scroll shows no gap. */
  overscanPx: number
}

/**
 * Intersect one lane with the viewport, without reading layout.
 *
 * Doing this arithmetically rather than with `getBoundingClientRect` is the
 * point: a rect read per lane per scroll frame is a forced synchronous layout,
 * and that is exactly the kind of cost that turns a scroll into a stutter.
 */
export function computeFilmstripWindow({
  laneLeftPx,
  laneWidthPx,
  scrollLeft,
  viewportWidth,
  overscanPx
}: FilmstripWindowInput): FilmstripWindow | null {
  if (
    !Number.isFinite(laneLeftPx) ||
    !Number.isFinite(laneWidthPx) ||
    laneWidthPx <= 0 ||
    !Number.isFinite(scrollLeft) ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(overscanPx) ||
    overscanPx < 0
  ) {
    return null
  }

  const start = Math.max(0, Math.min(laneWidthPx, scrollLeft - overscanPx - laneLeftPx))
  const end = Math.max(
    start,
    Math.min(laneWidthPx, scrollLeft + viewportWidth + overscanPx - laneLeftPx)
  )

  return {
    renderWidth: laneWidthPx,
    visibleStartPx: Math.floor(start),
    visibleEndPx: Math.ceil(end)
  }
}

/** One thumbnail slot: which tile index goes where, in lane-local px. */
export interface FilmstripSlot {
  /** Index into the extracted strip, 0-based. */
  tileIndex: number
  /** Lane-local x of the slot's left edge. */
  x: number
  /** Slot width in px. */
  width: number
}

export interface FilmstripSlotsInput {
  window: FilmstripWindow
  /** Width one thumbnail occupies on screen, in px. */
  slotWidthPx: number
  /** Seconds into the SOURCE that lane-local x=0 represents. */
  sourceStartSec: number
  /** Zoom, in px per second of timeline. */
  pxPerSec: number
  /** Seconds one extracted tile advances (from the strip manifest). */
  tileSec: number
  /** How many tiles the strip actually has. */
  tileCount: number
}

/**
 * The slot grid for a bounded window.
 *
 * Slots are anchored to the LANE, not to the visible window, so scrolling never
 * shifts the thumbnails sideways — a window that starts mid-slot begins at that
 * slot's real x, which may be slightly left of the visible edge. The canvas is
 * clipped to the lane, so the overhang costs nothing and the alternative
 * (re-anchoring per scroll) makes the strip visibly crawl.
 */
export function computeFilmstripSlots({
  window: win,
  slotWidthPx,
  sourceStartSec,
  pxPerSec,
  tileSec,
  tileCount
}: FilmstripSlotsInput): FilmstripSlot[] {
  if (
    slotWidthPx <= 0 ||
    pxPerSec <= 0 ||
    tileSec <= 0 ||
    tileCount <= 0 ||
    win.renderWidth <= 0 ||
    win.visibleEndPx <= win.visibleStartPx
  ) {
    return []
  }

  const lastSlot = Math.ceil(win.renderWidth / slotWidthPx)
  const firstVisible = Math.max(0, Math.floor(win.visibleStartPx / slotWidthPx))
  const lastVisible = Math.min(lastSlot, Math.ceil(win.visibleEndPx / slotWidthPx))

  const slots: FilmstripSlot[] = []
  for (let slot = firstVisible; slot < lastVisible; slot++) {
    const x = slot * slotWidthPx
    // Sample at the slot's CENTRE: sampling at its left edge biases the whole
    // strip half a slot early, which is visible as the thumbnail changing
    // slightly before the cut it belongs to.
    const centreSec = sourceStartSec + (x + slotWidthPx / 2) / pxPerSec
    const tileIndex = Math.min(tileCount - 1, Math.max(0, Math.round(centreSec / tileSec - 0.5)))
    slots.push({ tileIndex, x, width: slotWidthPx })
  }
  return slots
}

/** Where to draw a source bitmap so it COVERS the slot without distortion. */
export interface CoverRect {
  x: number
  y: number
  width: number
  height: number
}

export function computeCoverRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): CoverRect {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height }
}
