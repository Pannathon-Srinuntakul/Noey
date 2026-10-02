import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawCaptionText } from '../engine/captions'
import {
  CAPTION_LINE_GAP,
  captionBreakUnits,
  captionFont,
  captionWrapWidth,
  layoutCaption,
  resolveCaptionStyle,
  wrapCaptionText
} from './captionLayout'

/** Advance width: 10 per spacing character; Thai vowel/tone marks take none. */
const measure = (s: string): number => Array.from(s).filter((c) => !/\p{M}/u.test(c)).length * 10

/** Thai dictionary words of `text`, as Intl.Segmenter splits them. */
const thaiWords = (text: string): string[] =>
  Array.from(new Intl.Segmenter('th', { granularity: 'word' }).segment(text), (s) => s.segment)

/** Every row boundary falls between two words of `text`. */
function breaksOnlyBetweenWords(rows: string[], text: string): boolean {
  const boundaries = new Set<number>()
  let at = 0
  for (const w of thaiWords(text)) boundaries.add((at += w.length))
  let pos = 0
  for (const row of rows.slice(0, -1)) {
    pos = text.indexOf(row, pos) + row.length
    if (!boundaries.has(pos)) return false
  }
  return true
}

const OWNER_1 = 'ทรงสวยเข้ารูปใส่แล้วดูหุ่นเพรียวมาก'
const OWNER_2 = 'ใครสนใจเสื้อกล้ามสวยๆแบบนี้จิ้มสั่งที่ตะกร้าเหลืองได้เลยน้า'

describe('resolveCaptionStyle', () => {
  it('is the ASS style on the 1080x1920 canvas', () => {
    const s = resolveCaptionStyle({ font: 'kanit', size: 72 }, 1080, 1920)
    expect(s.sizePx).toBe(72)
    expect(s.outlinePx).toBe(4)
    expect(s.marginV).toBe(100)
    expect(s.font.startsWith('"Kanit"')).toBe(true)
    expect(captionFont(s)).toBe(`700 72px ${s.font}`)
  })

  it('scales with the frame, so the overlay and a smaller render agree', () => {
    const s = resolveCaptionStyle({ size: 72 }, 540, 960)
    expect(s.sizePx).toBe(36)
    expect(s.outlinePx).toBe(2)
    expect(s.marginV).toBe(50)
  })

  it('falls back to the ASS default size and face', () => {
    const s = resolveCaptionStyle(undefined, 1080, 1920)
    expect(s.sizePx).toBe(52)
    expect(s.font.startsWith('"Kanit"')).toBe(true)
    expect(s.color).toBe('#FFFFFF')
    expect(s.borderColor).toBe('#000000')
  })
})

describe('layoutCaption', () => {
  it('stacks rows upward from margin_v above the bottom edge', () => {
    const style = resolveCaptionStyle({ size: 100 }, 1080, 1920)
    // 35 Thai code points of which 27 take width → 270 at 10 each; wrap at 120.
    const rows = layoutCaption(OWNER_1, style, 140, 1920, measure)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[rows.length - 1].y).toBe(1920 - 100)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y - rows[i - 1].y).toBeCloseTo(100 * CAPTION_LINE_GAP)
    }
  })

  it('wraps at the renderer’s share of the frame width', () => {
    expect(captionWrapWidth(1080)).toBeCloseTo(928.8)
  })
})

describe('wrapCaptionText', () => {
  it('keeps a line that fits on one row', () => {
    expect(wrapCaptionText(OWNER_1, 1000, measure)).toEqual([OWNER_1])
  })

  it('never breaks a Thai word — the owner’s “เพรียวม / าก”', () => {
    // 16 spacing characters per row: a per-character wrap (the old renderer)
    // split "เพรียวมาก" after "ม".
    for (const width of [80, 100, 120, 160, 200]) {
      const rows = wrapCaptionText(OWNER_1, width, measure)
      expect(rows.join('')).toBe(OWNER_1)
      expect(breaksOnlyBetweenWords(rows, OWNER_1)).toBe(true)
      expect(rows.some((r) => r.endsWith('ม') && !r.endsWith('มาก'))).toBe(false)
      for (const r of rows) expect(measure(r)).toBeLessThanOrEqual(width)
    }
  })

  it('keeps ๆ on its word and every row within width', () => {
    for (const width of [90, 130, 170, 250]) {
      const rows = wrapCaptionText(OWNER_2, width, measure)
      expect(rows.join('')).toBe(OWNER_2)
      expect(breaksOnlyBetweenWords(rows, OWNER_2)).toBe(true)
      expect(rows.some((r) => r.startsWith('ๆ'))).toBe(false)
      for (const r of rows) expect(measure(r)).toBeLessThanOrEqual(width)
    }
  })

  it('breaks Latin at spaces and drops the space at the break', () => {
    expect(wrapCaptionText('hello big world', 90, measure)).toEqual(['hello big', 'world'])
  })

  it('keeps punctuation and brackets with their word', () => {
    const units = captionBreakUnits('ราคา 299 บาท! (ลดเหลือ) ใส่สบาย, โอเค?')
    expect(units.some((u) => /^[!,?)]/.test(u))).toBe(false)
    expect(units.some((u) => /\($/.test(u))).toBe(false)
    expect(units.join('')).toBe('ราคา 299 บาท! (ลดเหลือ) ใส่สบาย, โอเค?')
  })

  it('splits a word wider than a whole row between grapheme clusters only', () => {
    const rows = wrapCaptionText('เพรียวมาก', 30, measure)
    expect(rows.join('')).toBe('เพรียวมาก')
    for (const r of rows) expect(/^\p{M}/u.test(r)).toBe(false)
  })

  it('treats a newline as a forced break', () => {
    expect(wrapCaptionText('สวย\nมาก', 1000, measure)).toEqual(['สวย', 'มาก'])
  })

  describe('without Intl.Segmenter', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('falls back to characters but keeps marks on their consonant', () => {
      vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
      const rows = wrapCaptionText('หุ่นเพรียว', 30, measure)
      expect(rows.join('')).toBe('หุ่นเพรียว')
      for (const r of rows) expect(/^\p{M}/u.test(r)).toBe(false)
    })
  })
})

describe('drawCaptionText', () => {
  it('draws exactly the rows layoutCaption gives, at its baselines', () => {
    const fills: [string, number, number][] = []
    const ctx = {
      canvas: { width: 1080, height: 1920 },
      font: '',
      save: () => undefined,
      restore: () => undefined,
      measureText: (s: string) => ({ width: measure(s) * 4 }),
      strokeText: () => undefined,
      fillText: (t: string, x: number, y: number) => fills.push([t, x, y])
    } as unknown as CanvasRenderingContext2D
    const style = resolveCaptionStyle({ size: 72 }, 1080, 1920)
    drawCaptionText(ctx, OWNER_1, style)
    const expected = layoutCaption(OWNER_1, style, 1080, 1920, (s) => measure(s) * 4)
    expect(fills).toEqual(expected.map((r) => [r.text, 540, r.y]))
    expect(ctx.font).toBe(captionFont(style))
  })
})
