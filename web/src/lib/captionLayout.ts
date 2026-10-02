/**
 * Caption geometry and line breaking — the ONE place both the burn-in
 * (engine/captions.ts, drawn onto every output frame) and the editor's preview
 * overlay (components/timeline/captionOverlay.ts) get their numbers from.
 *
 * They used to keep their own: the renderer drew 72/1920 of the frame height in
 * the caption face with a 4px outline and wrapped at 86% of the width, while
 * the editor overlay was a fixed 15px line of UI font that the browser wrapped
 * at the stage's width. The same caption showed as three big lines in the
 * video and two small ones in the editor (owner report 2026-10-03).
 *
 * Every value is the ASS style that `backend/packages/video/caption.py`
 * (`resolve_caption_style`) writes for the desktop burn-in, on its
 * 1080x1920 PlayRes canvas, scaled to the real frame:
 *
 *   canvas        1080 x 1920 (PlayResX/Y)
 *   alignment     2  — bottom centre
 *   margin_v      100
 *   outline       4px
 *   default size  52
 *
 * Pure: no DOM, no canvas. Text width comes in as a `measure` callback so the
 * renderer and the overlay measure with their own canvas context, in the same
 * font, at the same size.
 */

import type { CaptionStyle } from './captionStyle'

/** ASS PlayResX/Y — every measurement below is relative to this. */
export const CAPTION_REF_WIDTH = 1080
export const CAPTION_REF_HEIGHT = 1920

/** Fontsize when a style carries none (caption.py `_STYLE_DEFAULT`). */
export const CAPTION_DEFAULT_SIZE = 52
const MARGIN_V = 100
const OUTLINE_PX = 4
/** Baseline-to-baseline distance, as a multiple of the font size. */
export const CAPTION_LINE_GAP = 1.25
/** Lines wrap at this share of the frame width (the output's side margins). */
export const CAPTION_WRAP_RATIO = 0.86
/** Captions are always bold (ASS `Bold: -1`). */
export const CAPTION_FONT_WEIGHT = 700

/** The four bundled faces, keyed as the UI keys them. */
const FONT_STACK: Record<string, string> = {
  kanit: '"Kanit", "Noto Sans Thai", sans-serif',
  prompt: '"Prompt", "Noto Sans Thai", sans-serif',
  sarabun: '"Sarabun", "Noto Sans Thai", sans-serif',
  anuphan: '"Anuphan", "Noto Sans Thai", sans-serif'
}

export type CaptionMode = 'static' | 'word_pop' | 'typewriter'

export interface ResolvedCaptionStyle {
  /** CSS font-family stack. */
  font: string
  sizePx: number
  color: string
  borderColor: string
  /** Visible outline OUTSIDE the glyph — the stroke is drawn twice this wide
   * under the fill, the way libass draws `Outline`. */
  outlinePx: number
  /** Bottom of the frame to the LAST line's baseline. */
  marginV: number
  mode: CaptionMode
}

/** Scale the reference style onto a frame of `frameWidth` x `frameHeight`. */
export function resolveCaptionStyle(
  style: Partial<CaptionStyle> | undefined | null,
  frameWidth: number,
  frameHeight: number
): ResolvedCaptionStyle {
  const scale = Math.min(frameWidth / CAPTION_REF_WIDTH, frameHeight / CAPTION_REF_HEIGHT) || 1
  const key = String(style?.font ?? 'kanit')
  return {
    font: FONT_STACK[key] ?? FONT_STACK.kanit,
    sizePx: Math.round((Number(style?.size) || CAPTION_DEFAULT_SIZE) * scale),
    color: String(style?.color ?? '#FFFFFF'),
    borderColor: String(style?.border_color ?? '#000000'),
    outlinePx: Math.max(1, Math.round(OUTLINE_PX * scale)),
    marginV: Math.round(MARGIN_V * scale),
    mode: (style?.mode as CaptionMode | undefined) ?? 'static'
  }
}

/** The CSS/canvas `font` shorthand a caption is drawn and measured in. */
export function captionFont(style: ResolvedCaptionStyle): string {
  return `${CAPTION_FONT_WEIGHT} ${style.sizePx}px ${style.font}`
}

/** Widest a caption row may be on a frame this wide. */
export function captionWrapWidth(frameWidth: number): number {
  return frameWidth * CAPTION_WRAP_RATIO
}

export interface CaptionRowLayout {
  text: string
  /** Baseline y, in frame pixels from the top. */
  y: number
}

/**
 * Rows and their baselines for `text` on a `frameWidth` x `frameHeight`
 * frame. Bottom centre (ASS alignment 2): the last row's baseline sits
 * `marginV` above the bottom edge and the others stack upward.
 */
export function layoutCaption(
  text: string,
  style: ResolvedCaptionStyle,
  frameWidth: number,
  frameHeight: number,
  measure: (s: string) => number
): CaptionRowLayout[] {
  const rows = wrapCaptionText(text, captionWrapWidth(frameWidth), measure)
  const lineHeight = style.sizePx * CAPTION_LINE_GAP
  const lastBaseline = frameHeight - style.marginV
  return rows.map((row, i) => ({
    text: row,
    y: lastBaseline - (rows.length - 1 - i) * lineHeight
  }))
}

// ── line breaking ───────────────────────────────────────────────────────────

/** Thai repetition / abbreviation marks: they belong to the word before. */
const STICKS_TO_PREVIOUS = /^[ๆฯ]/
/** Opening brackets and quotes: they belong to the word after. */
const OPENERS = /^[([{“‘«]+$/
const STRAIGHT_QUOTE = /^["']+$/
/** A combining mark: never the first thing on a row. */
const COMBINING = /^\p{M}/u

interface Segment {
  text: string
  /** A word, number or run of letters — vs punctuation or whitespace. */
  wordLike: boolean
}

/** Thai word boundaries (dictionary-based) and the usual ones everywhere else.
 * `null` when the runtime has no Intl.Segmenter — see `fallbackSegments`. */
function wordSegments(text: string): Segment[] | null {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (typeof Seg !== 'function') return null
  try {
    const seg = new Seg('th', { granularity: 'word' })
    return Array.from(seg.segment(text), (s) => ({
      text: s.segment,
      wordLike: s.isWordLike ?? /[\p{L}\p{N}]/u.test(s.segment)
    }))
  } catch {
    return null
  }
}

/** Without a segmenter: break at spaces, and — only when the text has none —
 * between characters, keeping each combining mark on its base. */
function fallbackSegments(text: string): Segment[] {
  if (/\s/.test(text)) {
    return text
      .split(/(\s+)/)
      .filter(Boolean)
      .map((t) => ({ text: t, wordLike: !/^\s+$/.test(t) }))
  }
  const out: Segment[] = []
  for (const ch of Array.from(text)) {
    if (out.length > 0 && COMBINING.test(ch)) out[out.length - 1].text += ch
    else out.push({ text: ch, wordLike: true })
  }
  return out
}

/**
 * The pieces a row may break between. A break is allowed between two words
 * and after whitespace; never before whitespace, closing punctuation, `ๆ`/`ฯ`
 * or a combining mark, and never after an opening bracket or quote.
 */
export function captionBreakUnits(text: string): string[] {
  const segs = wordSegments(text) ?? fallbackSegments(text)
  const units: string[] = []
  // The last unit ends in an opening bracket/quote: the next piece joins it.
  let openPending = false
  for (const s of segs) {
    const prev = units[units.length - 1]
    // A straight quote opens when it follows a space (or starts the text) and
    // closes otherwise — it is both characters.
    const opener =
      !s.wordLike &&
      (OPENERS.test(s.text) || (STRAIGHT_QUOTE.test(s.text) && (!prev || /\s$/.test(prev))))
    const glue =
      prev !== undefined &&
      (openPending ||
        /^\s/.test(s.text) ||
        (!s.wordLike && !opener) ||
        STICKS_TO_PREVIOUS.test(s.text) ||
        COMBINING.test(s.text))
    if (glue) units[units.length - 1] = prev + s.text
    else units.push(s.text)
    openPending = opener
  }
  return units
}

/** Grapheme clusters, for the one case a single word is wider than a row. */
function graphemes(text: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (typeof Seg === 'function') {
    try {
      return Array.from(new Seg('th', { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    } catch {
      // fall through
    }
  }
  return fallbackSegments(text.replace(/\s+/g, '')).map((s) => s.text)
}

/**
 * Break `text` into rows no wider than `maxWidth`, greedily, at word
 * boundaries only — Thai included, through dictionary word segmentation.
 *
 * The renderer used to split a space-less (Thai) line between any two
 * characters, so a row could end in the middle of a word: "แล้วดูหุ่นเพรียวม /
 * าก" (owner report 2026-10-03). Now a word is only ever split when it alone
 * is wider than a whole row, and then between grapheme clusters, so a vowel or
 * tone mark never lands on a row without its consonant.
 *
 * A newline in the text is a forced break.
 */
export function wrapCaptionText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const rows: string[] = []
  for (const para of text.split(/\r?\n/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    if (measure(trimmed) <= maxWidth) {
      rows.push(trimmed)
      continue
    }
    let current = ''
    const place = (unit: string): void => {
      const candidate = current + unit
      if (current.trim() && measure(candidate.trimEnd()) > maxWidth) {
        rows.push(current.trimEnd())
        current = unit.trimStart()
      } else {
        current = candidate
      }
    }
    for (const unit of captionBreakUnits(trimmed)) {
      if (measure(unit.trim()) > maxWidth) {
        // One word wider than a whole row: the only mid-word break there is.
        const trailing = /\s$/.test(unit)
        for (const g of graphemes(unit.trim())) place(g)
        if (trailing) current += ' '
      } else {
        place(unit)
      }
    }
    if (current.trim()) rows.push(current.trim())
  }
  return rows
}
