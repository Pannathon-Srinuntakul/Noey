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
 */
export function edgeZonePx(blockPx: number): number {
  return Math.max(0, Math.min(8, blockPx / 3))
}
