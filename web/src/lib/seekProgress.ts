/**
 * Played-portion fill for a `<input type="range">` seek bar.
 *
 * A bare range input paints one flat rail, so a half-watched clip looked
 * identical to an unwatched one — the head was the only clue (live report
 * 2026-08-13). Chromium has no `::-webkit-slider-runnable-track` progress
 * pseudo-element, so the fill is a gradient on the input's own background, the
 * same trick `ui/Slider` uses.
 */

/** Unplayed rail. The inline gradient replaces the element's `bg-` class
 * wholesale (`background` is a shorthand), so it must carry this itself. */
const RAIL = 'rgb(243 242 242 / 0.28)'

export function seekProgressBackground(pct: number): string {
  const p = Math.min(100, Math.max(0, pct))
  return `linear-gradient(to right, var(--color-accent) ${p}%, ${RAIL} ${p}%)`
}

/**
 * Repaint a seek input from its OWN current value.
 *
 * For imperative drivers (TimelineEditor writes `input.value` every frame
 * instead of re-rendering) React never sees the new time, so the fill has to be
 * pushed the same way the value is — call this wherever the value is written.
 */
export function paintSeekProgress(el: HTMLInputElement | null): void {
  if (!el) return
  const min = Number(el.min || 0)
  const max = Number(el.max || 0)
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0
  el.style.background = seekProgressBackground(pct)
}
