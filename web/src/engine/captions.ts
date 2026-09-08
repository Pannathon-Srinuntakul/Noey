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
 * The numbers below are the ASS style resolved by
 * `backend/packages/video/caption.py:resolve_caption_style`, so both builds
 * put the text in the same place at the same size:
 *
 *   canvas          1080 x 1920 (PlayResX/Y)
 *   alignment       2  — bottom centre
 *   margin_v        100
 *   outline         4px
 *   default size    52
 *   words per line  3
 *
 * Sizes are expressed against that 1080x1920 reference and scaled to whatever
 * the real output is, so a caption on a 720x1280 render is the same size
 * relative to the picture.
 */

import type { CaptionLine } from '../lib/captionLines'
import type { CaptionStyle } from '../lib/captionStyle'

/** ASS PlayResX/Y — every measurement below is relative to this. */
const REF_WIDTH = 1080
const REF_HEIGHT = 1920

const DEFAULT_SIZE = 52
const MARGIN_V = 100
const OUTLINE_PX = 4
const LINE_GAP = 1.25

/** The four bundled faces, keyed as the UI keys them. */
const FONT_STACK: Record<string, string> = {
  kanit: '"Kanit", "Noto Sans Thai", sans-serif',
  prompt: '"Prompt", "Noto Sans Thai", sans-serif',
  sarabun: '"Sarabun", "Noto Sans Thai", sans-serif',
  anuphan: '"Anuphan", "Noto Sans Thai", sans-serif'
}

export interface CaptionWord {
  word: string
  start: number
  end: number
}

export interface ResolvedCaptionStyle {
  font: string
  sizePx: number
  color: string
  borderColor: string
  outlinePx: number
  marginV: number
  mode: 'static' | 'word_pop' | 'typewriter'
}

/** Scale the reference style onto the real output size. */
export function resolveCaptionStyle(
  style: CaptionStyle | undefined,
  outputWidth: number,
  outputHeight: number
): ResolvedCaptionStyle {
  const scale = Math.min(outputWidth / REF_WIDTH, outputHeight / REF_HEIGHT) || 1
  const key = String(style?.font ?? 'kanit')
  return {
    font: FONT_STACK[key] ?? FONT_STACK.kanit,
    sizePx: Math.round((Number(style?.size) || DEFAULT_SIZE) * scale),
    color: String(style?.color ?? '#FFFFFF'),
    borderColor: String(style?.border_color ?? '#000000'),
    outlinePx: Math.max(1, Math.round(OUTLINE_PX * scale)),
    marginV: Math.round(MARGIN_V * scale),
    mode: (style?.mode as ResolvedCaptionStyle['mode']) ?? 'static'
  }
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

/** Break a line to fit the frame, at most `maxLines` rows. */
function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text]
  // Thai has no spaces, so fall back to breaking on characters when the
  // whitespace split does not help.
  const parts = text.includes(' ') ? text.split(' ') : Array.from(text)
  const sep = text.includes(' ') ? ' ' : ''
  const rows: string[] = []
  let current = ''
  for (const part of parts) {
    const candidate = current ? current + sep + part : part
    if (current && ctx.measureText(candidate).width > maxWidth) {
      rows.push(current)
      current = part
    } else {
      current = candidate
    }
  }
  if (current) rows.push(current)
  return rows
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

  const { width, height } = ctx.canvas
  ctx.save()
  ctx.font = `700 ${style.sizePx}px ${style.font}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const rows = wrap(ctx, text, width * 0.86)
  const lineHeight = style.sizePx * LINE_GAP
  // Alignment 2 in ASS: bottom centre, `margin_v` up from the bottom edge.
  const baseline = height - style.marginV
  const startY = baseline - (rows.length - 1) * lineHeight

  for (let i = 0; i < rows.length; i++) {
    const y = startY + i * lineHeight
    ctx.strokeStyle = style.borderColor
    ctx.lineWidth = style.outlinePx * 2
    ctx.strokeText(rows[i], width / 2, y)
    ctx.fillStyle = style.color
    ctx.fillText(rows[i], width / 2, y)
  }
  ctx.restore()
}

/**
 * Make sure the caption faces are loaded before the first frame is drawn.
 *
 * A worker's canvas silently falls back to a default font if the face is not
 * ready, and the failure is invisible until someone looks at the output.
 */
export async function ensureCaptionFont(style: ResolvedCaptionStyle): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await document.fonts.load(`700 ${style.sizePx}px ${style.font}`)
    await document.fonts.ready
  } catch {
    // Rendering with the fallback face is better than not rendering.
  }
}
