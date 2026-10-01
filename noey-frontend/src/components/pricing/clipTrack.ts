/**
 * The arithmetic behind /pricing's clip track (PlanRail's ClipTrack): where a
 * pointer on the lane puts the clip's end, and what each key does to it. Kept
 * apart from the component so it can be tested without a browser.
 */

/** The lane's inset on each side: the clip starts 2px in (pricing.css). */
export const LANE_INSET = 2;

/**
 * The length a pointer at `offset` px from the lane's left edge sets, on a
 * lane `width` px wide whose right end is `longest` minutes: whole minutes,
 * never under 1 or over `longest`.
 */
export function minutesAt(offset: number, width: number, longest: number): number {
  const span = width - LANE_INSET * 2;
  if (!(span > 0)) return 1;
  const share = Math.min(1, Math.max(0, (offset - LANE_INSET) / span));
  return Math.min(longest, Math.max(1, Math.round(share * longest)));
}

/** A page's step: five minutes on the 30-minute scale, ten on the two-hour one. */
export function pageStep(longest: number): number {
  return longest > 60 ? 10 : 5;
}

/**
 * The length a key moves the handle to, as a slider's keys do (WAI-ARIA
 * slider pattern): arrows ±1 minute, PageUp/PageDown a page, Home/End the
 * ends. Null for a key the handle does not use.
 */
export function minutesForKey(key: string, minutes: number, longest: number): number | null {
  const clamp = (value: number) => Math.min(longest, Math.max(1, value));
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(minutes + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(minutes - 1);
    case "PageUp":
      return clamp(minutes + pageStep(longest));
    case "PageDown":
      return clamp(minutes - pageStep(longest));
    case "Home":
      return 1;
    case "End":
      return longest;
    default:
      return null;
  }
}
