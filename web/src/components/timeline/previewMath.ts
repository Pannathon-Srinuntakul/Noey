import { clamp, findSegmentAt, type EditedSegment } from '../../lib/timelineMath'

/**
 * The preview's arithmetic, kept out of the player hook so it can be tested
 * without a <video>: where the edited clock is for a source-local position,
 * when a playing scene is over, where to land after the cut list changed, and
 * how the timeline follows the playhead.
 */

/** The edited-clock time of source-local `local` inside the scene that starts
 * at `editedIn` — clamped to that scene, so a frame the element shows a hair
 * past the out-point (the frame loop only looks once per frame) never draws
 * the playhead into the next scene before the swap. */
export function editedTimeIn(
  editedIn: number,
  cut: { in: number; out: number },
  local: number
): number {
  const dur = Math.max(cut.out - cut.in, 0)
  return clamp(editedIn + (local - cut.in), editedIn, editedIn + dur)
}

/**
 * A playing scene is over once the element reaches its out-point — the WHOLE
 * scene, the way the render cuts it. It used to switch 50 ms early, so every
 * scene lost its last frame or two in the preview and the playhead jumped
 * forward at each cut. A file that ends before the stored out-point (probe
 * durations round) ends the scene where the file ends.
 */
export function sceneIsOver(
  currentTime: number,
  cut: { out: number },
  mediaDurationSec: number
): boolean {
  const end =
    Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
      ? Math.min(cut.out, mediaDurationSec)
      : cut.out
  return currentTime >= end - 0.001
}

export interface EditedPosition {
  seg: EditedSegment
  /** Source-local time inside seg.cut. */
  local: number
  /** The same moment on the edited clock. */
  t: number
}

/**
 * Where the edited-view preview should be, given what it was showing.
 *
 * The scene it was on wins while it still exists and the frame is still
 * inside it (`slackSec` past the out-point is tolerated: a playing element is
 * read once per frame and can be that far past before it is switched). Then
 * the playhead keeps its FRAME — a scene deleted or moved before it only
 * moves it on the clock. Otherwise (the scene was deleted, or trimmed away
 * under the frame) the clock position wins, re-resolved against the new list.
 */
export function resolveEditedPosition(
  segs: EditedSegment[],
  cutId: string | null,
  sourceTime: number | null,
  fallbackT: number,
  slackSec = 0.1
): EditedPosition | null {
  if (segs.length === 0) return null
  const seg = cutId ? segs.find((s) => s.cut.id === cutId) : undefined
  if (
    seg &&
    sourceTime !== null &&
    sourceTime >= seg.cut.in - 0.001 &&
    sourceTime <= seg.cut.out + slackSec
  ) {
    const local = clamp(sourceTime, seg.cut.in, seg.cut.out)
    return { seg, local, t: editedTimeIn(seg.editedIn, seg.cut, local) }
  }
  const total = segs[segs.length - 1].editedOut
  const t = clamp(fallbackT, 0, total)
  const at = findSegmentAt(segs, t)!
  const local = clamp(at.cut.in + (t - at.editedIn), at.cut.in, at.cut.out)
  return { seg: at, local, t: editedTimeIn(at.editedIn, at.cut, local) }
}

/**
 * Follow-scroll, page by page: nothing while the playhead is on screen; once
 * it runs off either side, the view turns a page so it sits just inside the
 * left edge again. Returns the new scrollLeft, or null to leave it.
 */
export function followScrollLeft(
  playheadX: number,
  scrollLeft: number,
  clientWidth: number,
  headerColPx: number
): number | null {
  const leftEdge = scrollLeft + headerColPx + 16
  const rightEdge = scrollLeft + clientWidth - 48
  if (playheadX >= leftEdge && playheadX <= rightEdge) return null
  return Math.max(0, playheadX - headerColPx - 16)
}
