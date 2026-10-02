/**
 * Burned-in captions, drawn straight onto the frame.
 *
 * The desktop writes an ASS subtitle file and lets ffmpeg's libass burn it in.
 * There is no libass here, so this draws the same thing with `fillText` —
 * which is not a downgrade for this app's language: the browser shapes Thai
 * with the same HarfBuzz build Chrome uses everywhere else, so vowels and tone
 * marks land correctly without shipping a font to a renderer that has to be
 * told where they are.
 *
 * Size, outline, bottom margin and line breaking come from
 * lib/captionLayout.ts — the ASS style
 * `backend/packages/video/caption.py:resolve_caption_style` writes, on its
 * 1080x1920 canvas, scaled to the real output. The editor's preview overlay
 * draws with `drawCaptionText` below through the same module, so what the
 * editor shows is what the render burns in.
 */

import {
  captionFont,
  layoutCaption,
  resolveCaptionStyle,
  type ResolvedCaptionStyle
} from '../lib/captionLayout'
import type { CaptionLine } from '../lib/captionLines'

export type { ResolvedCaptionStyle }
export { resolveCaptionStyle }

export interface CaptionWord {
  word: string
  start: number
  end: number
}

/**
 * What text is on screen at `timeSec`.
 *
 * `word_pop` and `typewriter` reveal a line progressively, so they need the
 * per-word timings; without them the whole line shows at once, which is what
 * `static` does anyway.
 */
function textAt(
  line: CaptionLine,
  timeSec: number,
  mode: ResolvedCaptionStyle['mode'],
  words: CaptionWord[]
): string {
  if (mode === 'static') return line.text
  const inLine = words.filter((w) => w.start >= line.start - 0.01 && w.end <= line.end + 0.01)
  if (inLine.length === 0) return line.text
  const shown = inLine.filter((w) => w.start <= timeSec)
  if (shown.length === 0) return ''
  if (mode === 'word_pop' || mode === 'typewriter') return joinWords(shown.map((w) => w.word))
  return line.text
}

/** No space between two Thai tokens; a normal space everywhere else. Mirrors
 * `_join_words` in caption.py and `joinWords` in lib/captionLines.ts. */
const THAI = /[฀-๿]/

function joinWords(words: string[]): string {
  let out = ''
  let prevLast = ''
  for (const raw of words) {
    const w = raw.trim()
    if (!w) continue
    if (out && !(THAI.test(prevLast) && THAI.test(w[0]))) out += ' '
    out += w
    prevLast = w[w.length - 1]
  }
  return out
}

/**
 * Draw whichever caption belongs at `timeSec` onto an already-composed frame.
 *
 * Call it last: captions sit on top of the picture.
 */
export function drawCaption(
  ctx: OffscreenCanvasRenderingContext2D,
  timeSec: number,
  lines: CaptionLine[],
  style: ResolvedCaptionStyle,
  words: CaptionWord[] = []
): void {
  const line = lines.find((l) => timeSec >= l.start && timeSec < l.end)
  if (!line) return

  const text = textAt(line, timeSec, style.mode, words).trim()
  if (!text) return

  drawCaptionText(ctx, text, style)
}

/** Any 2D context a caption is drawn on: the render's offscreen frame or the
 * editor's on-screen overlay. */
export type CaptionContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/**
 * Draw one caption's text, wrapped and placed, on a frame the size of
 * `frameWidth` x `frameHeight` (default: the context's canvas). `style` must
 * be resolved for that same frame size. The overlay passes the output's size
 * and scales the context to its own pixels, so the rows break exactly where
 * the render's do.
 */
export function drawCaptionText(
  ctx: CaptionContext,
  text: string,
  style: ResolvedCaptionStyle,
  frameWidth: number = ctx.canvas.width,
  frameHeight: number = ctx.canvas.height
): void {
  if (!text.trim()) return
  ctx.save()
  ctx.font = captionFont(style)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const rows = layoutCaption(text, style, frameWidth, frameHeight, (s) => ctx.measureText(s).width)
  for (const row of rows) {
    ctx.strokeStyle = style.borderColor
    ctx.lineWidth = style.outlinePx * 2
    ctx.strokeText(row.text, frameWidth / 2, row.y)
    ctx.fillStyle = style.color
    ctx.fillText(row.text, frameWidth / 2, row.y)
  }
  ctx.restore()
}

/** Thai and Latin sample: `FontFaceSet.load` fetches only the unicode-range
 * subsets that cover the text it is given, and its default (" ") covers Latin
 * alone — the Thai subset of a @fontsource face would never be asked for. */
export const CAPTION_FONT_PROBE = 'กขคเพรียวมาก Aa0'

/**
 * Make sure the caption faces are loaded before the first frame is drawn.
 *
 * A worker's canvas silently falls back to a default font if the face is not
 * ready, and the failure is invisible until someone looks at the output.
 */
export async function ensureCaptionFont(style: ResolvedCaptionStyle): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await document.fonts.load(captionFont(style), CAPTION_FONT_PROBE)
    await document.fonts.ready
  } catch {
    // Rendering with the fallback face is better than not rendering.
  }
}
