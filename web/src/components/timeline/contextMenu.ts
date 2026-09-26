/**
 * Chrome helpers — pure arithmetic behind the context menu and the transport's
 * timecode entry, kept out of the components so vitest (no jsdom here) can
 * pin them.
 */

/** The panel width ui/Menu draws at. */
export const MENU_W_PX = 210
/** Keep this much air between the panel and the viewport edge. */
export const MENU_MARGIN_PX = 8

/**
 * Where to put a `w × h` panel opened at the pointer (`x`, `y`) so it stays
 * inside a `vw × vh` viewport: it flips to the LEFT of the pointer when it
 * would run off the right edge and ABOVE it when it would run off the
 * bottom, then clamps as a last resort (a panel taller than the viewport).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number
): { left: number; top: number } {
  let left = x
  let top = y
  if (left + w + MENU_MARGIN_PX > vw) left = x - w
  if (top + h + MENU_MARGIN_PX > vh) top = y - h
  left = Math.max(MENU_MARGIN_PX, Math.min(left, vw - w - MENU_MARGIN_PX))
  top = Math.max(MENU_MARGIN_PX, Math.min(top, vh - h - MENU_MARGIN_PX))
  // A viewport narrower than the panel: hug the left / top edge rather than
  // report a negative offset.
  return { left: Math.max(0, left), top: Math.max(0, top) }
}

/**
 * `"m:ss:ff"` (or `"h:mm:ss:ff"`) → seconds at `fps`, or null when the text
 * is not that form. The frames group must be exactly two digits and under
 * `fps`; anything else (a third group with a decimal, one digit, "30") is
 * left to the plain timecode parser so `1:02:03` still reads as h:mm:ss.
 */
export function parseFramesForm(text: string, fps = 30): number | null {
  const s = text.trim()
  const m = /^(?:(\d+):)?(\d+):([0-5]?\d):(\d{2})$/.exec(s)
  if (!m) return null
  const frames = Number(m[4])
  if (!Number.isInteger(fps) || fps <= 0 || frames >= fps) return null
  const h = m[1] === undefined ? 0 : Number(m[1])
  const min = Number(m[2])
  const sec = Number(m[3])
  return h * 3600 + min * 60 + sec + frames / fps
}

/** The next index for ↑/↓ inside a menu, wrapping at both ends. */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
