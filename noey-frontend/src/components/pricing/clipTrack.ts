/**
 * The arithmetic behind /pricing's clip track (PlanRail's ClipTrack): where a
 * pointer on the lane puts the clip's end, what a press on the lane has turned
 * into (a tap, a drag, or the page scrolling), and what each key does. Kept
 * apart from the component so it can be tested without a browser.
 */

/**
 * The lane's insets (pricing.css): the clip starts 2px in, and the scale ends
 * 14px before the lane's right edge, so the last ceiling marker sits inside
 * the lane instead of reading as its border.
 */
export const LANE_START = 2;
export const LANE_END = 14;

/**
 * The length a pointer at `offset` px from the lane's left edge sets, on a
 * lane `width` px wide whose scale ends at `longest` minutes: whole minutes,
 * never under 1 or over `longest`.
 */
export function minutesAt(offset: number, width: number, longest: number): number {
  const span = width - LANE_START - LANE_END;
  if (!(span > 0)) return 1;
  const share = Math.min(1, Math.max(0, (offset - LANE_START) / span));
  return Math.min(longest, Math.max(1, Math.round(share * longest)));
}

/** How far a press may wander and still be a tap, and how far it must go to be decided. */
export const TAP_SLOP = 6;

/**
 * What a press on the lane (not on the handle) has become after moving `dx`,
 * `dy` px: still undecided inside the slop; a drag once the movement is
 * clearly horizontal; otherwise the page is scrolling, and the track lets go.
 */
export function laneGesture(dx: number, dy: number, slop = TAP_SLOP): "undecided" | "drag" | "scroll" {
  const across = Math.abs(dx);
  const down = Math.abs(dy);
  if (across < slop && down < slop) return "undecided";
  return across > down ? "drag" : "scroll";
}

/** Whether a press released after moving `dx`, `dy` px was a tap (it jumps the end there). */
export function isTap(dx: number, dy: number, slop = TAP_SLOP): boolean {
  return Math.hypot(dx, dy) < slop;
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

/**
 * The ruler's timecodes for a scale, each ranked by the narrowest track that
 * still shows it: 1 always, 2 from a mid width, 3 only on a wide track.
 */
export function rulerMarks(longest: number): { minutes: number; rank: 1 | 2 | 3 }[] {
  if (longest > 60) {
    return Array.from({ length: Math.floor(longest / 15) + 1 }, (_, index) => {
      const minutes = index * 15;
      const rank: 1 | 2 | 3 = minutes % 60 === 0 ? 1 : minutes % 30 === 0 ? 2 : 3;
      return { minutes, rank };
    });
  }
  return Array.from({ length: Math.floor(longest / 5) + 1 }, (_, index) => {
    const minutes = index * 5;
    const rank: 1 | 2 | 3 = minutes % 10 === 0 ? 1 : 3;
    return { minutes, rank };
  });
}
