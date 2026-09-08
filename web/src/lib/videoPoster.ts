/**
 * A `<video>` with `preload="metadata"` fetches the header and paints NOTHING —
 * every preview surface in the app sat as a black box until something seeked
 * it. There is no poster image to fall back on (the app never generates one),
 * so the fix is to nudge the element off frame 0 once, which forces a decode.
 *
 * The nudge then has to be UNDONE. Leaving the head where it landed is what put
 * "0:00.2" under a clip the user had not touched yet, and pressing play started
 * a fifth of a second in — a real edit tool has to open on its own first frame.
 * So: nudge, wait for the decode, seek back to 0. The frame stays painted
 * because it was decoded; the clock reads 0:00.0 because that is where the clip
 * starts.
 */
export function seekToPosterFrame(el: HTMLVideoElement): void {
  if (el.currentTime > 0) return
  const d = el.duration
  const nudge = Number.isFinite(d) && d > 0 ? Math.min(0.25, d / 2) : 0.25

  const rewind = (): void => {
    el.removeEventListener('seeked', rewind)
    // Guard against a caller (or the user) having seeked somewhere real in the
    // meantime — only the nudge itself is undone.
    if (Math.abs(el.currentTime - nudge) < 0.01) el.currentTime = 0
  }
  el.addEventListener('seeked', rewind)
  el.currentTime = nudge
}
