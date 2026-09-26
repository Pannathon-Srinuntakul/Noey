/**
 * Arithmetic three or four jobs each had a private copy of.
 *
 * Each copy was correct; the risk was one of them drifting — a render's frame
 * quantisation and its audio placement have to agree to the frame, and they
 * agree by construction only while they share the function.
 */

/** Even dimensions — H.264 requires them, and odd sizes fail to configure. */
export function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

/**
 * A duration rounded to a whole number of frames at `fps`, never shorter than
 * one frame.
 *
 * `renderCutList` rounds each cut to whole frames independently; summing raw
 * durations gave the audio a different length from the picture by the
 * accumulated rounding of every cut. Every length that has to line up with
 * the picture goes through this.
 */
export function quantiseToFrames(sec: number, fps: number): number {
  return Math.max(1, Math.round(sec * fps)) / fps
}
