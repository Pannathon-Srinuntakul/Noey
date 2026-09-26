// ---- geometry constants (R3: ruler + lanes line up at 40px per second) -----
// HANDOFF §3 Timeline primitives — these five are a spec, not taste: the ruler,
// the header column and every lane are drawn from them, so changing one without
// the others puts the labels out of line with the footage.
export const HEADER_COL_PX = 92
export const RULER_PX = 22
export const IMG_LANE_PX = 40
export const VO_LANE_PX = 32
export const MUSIC_LANE_PX = 32
export const CAPTION_LANE_PX = 24
export const TRACK_GAP_PX = 3
/** Empty room after the last block so the end of the cut is grabbable. */
export const TAIL_PX = 160
export const MIN_LANE_PX = 80
export const MIN_PX_PER_SEC = 4
export const MAX_PX_PER_SEC = 160
/** One video frame at the 30fps the pipeline renders — the ←/→ nudge unit. */
export const FRAME_SEC = 1 / 30

// ---- interaction constants (editor-standard pass, 2026-09-27) -------------
/** Snap pull in SCREEN px — converted to seconds at the current zoom, so the
 * magnet feels the same at 4 px/s and 160 px/s (a fixed 0.2 s was 32 px zoomed
 * in and 0.8 px zoomed out). */
export const SNAP_THRESHOLD_PX = 8
/** Scrub snap is softer than a trim's so frame-precise scrubbing still works
 * when zoomed in. */
export const SCRUB_SNAP_THRESHOLD_PX = 6
/** Width of the band inside the viewport edge where a drag starts scrolling. */
export const DRAG_AUTOSCROLL_EDGE_PX = 40
/** Auto-scroll px per frame at the very edge (viewportMath ramps it quadratically). */
export const DRAG_AUTOSCROLL_MAX_PX = 24
/** Trim zone on a coarse (touch) pointer — the ~44 px touch-target rule both
 * mobile NLEs follow; the 8 px mouse zone is unhittable with a finger. */
export const COARSE_EDGE_ZONE_PX = 22
/** Playhead head width on a coarse pointer, for the same reason. */
export const COARSE_PLAYHEAD_GRAB_PX = 24
/** Frames per Alt+Shift+←/→ nudge (Alt+←/→ is one frame). */
export const NUDGE_FRAMES_BIG = 10
/** Shift+K plays this much before the nearest cut… */
export const PLAY_AROUND_PRE_SEC = 1
/** …and this much after it. */
export const PLAY_AROUND_POST_SEC = 1
/** How long a changed block's ring stays lit (was hard-coded in the viewport hook). */
export const FLASH_MS = 850
/** Touch long-press before a block is picked up for reorder instead of scrolled. */
export const LONG_PRESS_MS = 300

// Track NAMES are ink-3; only the count beside ภาพ is muted (design R3).
// pl-3: the labels sat flush against the window edge — a sticky column with
// no left padding reads as clipped text (live report 2026-08-13).
// z-40, above every lane element (blocks are z-0/z-20, trim handles z-30):
// the label column is what lane content scrolls UNDER, and at the same
// z-index DOM order won instead — a cut block dragged to the left edge was
// painted on top of its own track name (live report 2026-08-13).
export const trackLabelCls =
  'sticky left-0 z-40 flex h-full shrink-0 items-center gap-1.5 bg-ground pr-3 pl-3 text-[13px] text-ink-3'

/**
 * Width of an unselected block's invisible trim zone on each edge (TrimBar):
 * 8px, narrowed to a third of the block on a narrow one, so EVERY block's
 * edges trim (owner, 2026-09-22 — after พอดีจอ on a long project most scenes
 * are only a few px wide) while its middle third is still there to select
 * and drag. Blocks under 24px used to get no zones at all and still needed
 * select, then trim.
 *
 * `coarse` (a touch pointer) widens the zone to COARSE_EDGE_ZONE_PX under the
 * same one-third rule — a finger cannot land on an 8 px strip.
 */
export function edgeZonePx(blockPx: number, coarse = false): number {
  const full = coarse ? COARSE_EDGE_ZONE_PX : 8
  return Math.max(0, Math.min(full, blockPx / 3))
}
