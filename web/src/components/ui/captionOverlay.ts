import { drawCaptionText, CAPTION_FONT_PROBE } from '../../engine/captions'
import {
  CAPTION_REF_HEIGHT,
  CAPTION_REF_WIDTH,
  captionFont,
  resolveCaptionStyle
} from '../../lib/captionLayout'
import type { CaptionStyle } from '../../lib/captionStyle'

/**
 * The editor's caption preview: the burn-in's own drawing, on a <canvas> laid
 * over the frame.
 *
 * It was a <div> of 15px UI font that the browser wrapped at the stage's width,
 * so a caption that burned in as three big rows read as two small ones in the
 * editor. Now it is `drawCaptionText` — the function the render draws every
 * output frame with — laid out on the OUTPUT's pixel grid (1080x1920 unless the
 * caller knows better) and scaled onto however many screen pixels the stage
 * has, so the rows break at the same words, in the same face, at the same size
 * and height in the frame.
 *
 * The canvas's intrinsic size is the frame's aspect, and it is styled
 * `object-contain` like the <video>s, so it letterboxes exactly as the picture
 * does.
 *
 * Painting is imperative (the editor drives it per frame from the player
 * loop) and cached: a call whose text, style and size are unchanged draws
 * nothing.
 */

export interface CaptionOverlayState {
  text: string
  /** null: the project has no caption style yet — the default one previews. */
  style: CaptionStyle | null
  /** The output frame the render would draw on. */
  frameWidth: number
  frameHeight: number
}

const DEFAULT_STATE: CaptionOverlayState = {
  text: '',
  style: null,
  frameWidth: CAPTION_REF_WIDTH,
  frameHeight: CAPTION_REF_HEIGHT
}

interface Painted extends CaptionOverlayState {
  /** Canvas pixels the last paint was laid out for. */
  pixelWidth: number
  pixelHeight: number
  /** The face was still loading at the last paint. */
  fontPending: boolean
}

const painted = new WeakMap<HTMLCanvasElement, Painted>()

function sameStyle(a: CaptionStyle | null, b: CaptionStyle | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.font === b.font &&
    a.size === b.size &&
    a.color === b.color &&
    a.border_color === b.border_color &&
    a.mode === b.mode
  )
}

/** Device pixels the canvas needs for its on-screen box, in the frame's aspect. */
function pixelSize(
  canvas: HTMLCanvasElement,
  frameWidth: number,
  frameHeight: number
): { w: number; h: number } {
  const boxW = canvas.clientWidth
  const boxH = canvas.clientHeight
  if (boxW <= 0 || boxH <= 0) return { w: 0, h: 0 }
  // object-contain: the frame fills the box along its tighter side.
  const fit = Math.min(boxW / frameWidth, boxH / frameHeight)
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  // Never more pixels than the output itself has — no sharper than the render.
  const k = Math.min(fit * dpr, 1)
  return { w: Math.max(1, Math.round(frameWidth * k)), h: Math.max(1, Math.round(frameHeight * k)) }
}

/**
 * Update what the overlay shows and repaint if anything (including the
 * canvas's on-screen size) changed. Pass `{}` to re-check the size only — the
 * stage's ResizeObserver does.
 */
export function paintCaptionOverlay(
  canvas: HTMLCanvasElement | null,
  next: Partial<CaptionOverlayState>
): void {
  if (!canvas) return
  const prev = painted.get(canvas)
  const state: CaptionOverlayState = { ...DEFAULT_STATE, ...prev, ...next }
  if (!(state.frameWidth > 0) || !(state.frameHeight > 0)) {
    state.frameWidth = CAPTION_REF_WIDTH
    state.frameHeight = CAPTION_REF_HEIGHT
  }
  const { w, h } = pixelSize(canvas, state.frameWidth, state.frameHeight)
  if (
    prev &&
    !prev.fontPending &&
    prev.text === state.text &&
    sameStyle(prev.style, state.style) &&
    prev.frameWidth === state.frameWidth &&
    prev.frameHeight === state.frameHeight &&
    prev.pixelWidth === w &&
    prev.pixelHeight === h
  )
    return

  const style = resolveCaptionStyle(state.style ?? undefined, state.frameWidth, state.frameHeight)
  const font = captionFont(style)
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  const text = state.text.trim()
  // Drawn before the face arrives, the rows would be measured in a fallback
  // font and break in different places. Paint now anyway (better than a
  // blank), and again the moment it has loaded.
  const fontPending = !!text && !!fonts && !fonts.check(font, CAPTION_FONT_PROBE)
  painted.set(canvas, { ...state, pixelWidth: w, pixelHeight: h, fontPending })
  if (fontPending) {
    void fonts!
      .load(font, CAPTION_FONT_PROBE)
      .then(() => paintCaptionOverlay(canvas, {}))
      .catch(() => undefined)
  }

  // The words themselves, for assistive tech (canvas fallback content).
  if (canvas.textContent !== text) canvas.textContent = text
  if (w === 0 || h === 0) return
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!text) return
  // Lay out on the OUTPUT's grid, draw onto ours.
  ctx.setTransform(w / state.frameWidth, 0, 0, h / state.frameHeight, 0, 0)
  drawCaptionText(ctx, text, style, state.frameWidth, state.frameHeight)
}
