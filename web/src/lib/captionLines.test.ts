/**
 * These cases mirror `_join_words` in backend/packages/video/caption.py.
 *
 * The two implementations exist because the editor groups lines client-side on
 * first open (no server round-trip) while the burn-in happens in Python. They
 * drifted once already: this file's join used a plain `' '` separator, so the
 * editor listed "ติด ขน ตา" for a line the rendered video showed as "ติดขนตา".
 * If the Python rule changes, change it here in the same commit.
 */

import { clipAbsOffsets, remapWordsToOutput } from './timelineMath'
import type { EditCut } from './editorApi'
import { describe, expect, it } from 'vitest'

import {
  captionLinesToSrt,
  captionWordsFromLines,
  dubCaptionLines,
  groupWordsIntoLines,
  joinWords,
  segmentWords,
  type DubScene
} from './captionLines'

const w = (
  word: string,
  start: number,
  end: number
): { word: string; start: number; end: number } => ({
  word,
  start,
  end
})

describe('joinWords', () => {
  it('never puts a space between two Thai tokens', () => {
    expect(joinWords(['ติด', 'ขน', 'ตา'])).toBe('ติดขนตา')
    expect(joinWords(['เสร็จ', 'แล้ว', 'นะคะ'])).toBe('เสร็จแล้วนะคะ')
  })

  it('spaces Latin words so they do not run together', () => {
    expect(joinWords(['Oh', 'My', 'God'])).toBe('Oh My God')
  })

  it('spaces the Thai/Latin boundary in both directions', () => {
    expect(joinWords(['อันดับ', 'แรก', 'Oh'])).toBe('อันดับแรก Oh')
    expect(joinWords(['God', 'แล้ว', 'ทา'])).toBe('God แล้วทา')
  })

  it('spaces digits away from Thai', () => {
    expect(joinWords(['ราคา', '199', 'บาท'])).toBe('ราคา 199 บาท')
  })

  it('trims and drops empty tokens', () => {
    expect(joinWords([' ติด ', '', '   ', 'ขน'])).toBe('ติดขน')
  })

  it('returns empty for no usable tokens', () => {
    expect(joinWords([])).toBe('')
    expect(joinWords(['  '])).toBe('')
  })
})

describe('groupWordsIntoLines', () => {
  it('groups into lines of three and joins them Thai-aware', () => {
    const lines = groupWordsIntoLines([
      w('ติด', 2.48, 2.64),
      w('ขน', 2.64, 2.94),
      w('ตา', 2.94, 3.3),
      w('เสร็จ', 3.3, 3.6),
      w('แล้ว', 3.6, 4.0),
      w('นะคะ', 4.0, 6.54)
    ])
    expect(lines.map((l) => l.text)).toEqual(['ติดขนตา', 'เสร็จแล้วนะคะ'])
    expect(lines[0]).toMatchObject({ start: 2.48, end: 3.3 })
    expect(lines[1]).toMatchObject({ start: 3.3, end: 6.54 })
  })

  it('honours a custom words-per-line', () => {
    const lines = groupWordsIntoLines([w('ก', 0, 1), w('ข', 1, 2), w('ค', 2, 3)], 2)
    expect(lines.map((l) => l.text)).toEqual(['กข', 'ค'])
  })

  it('drops a group with no duration', () => {
    expect(groupWordsIntoLines([w('ก', 1, 1)])).toEqual([])
  })

  it('gives every line a distinct id', () => {
    const lines = groupWordsIntoLines([w('ก', 0, 1), w('ข', 1, 2), w('ค', 2, 3), w('ง', 3, 4)])
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length)
  })
})

describe('dubCaptionLines', () => {
  const line = (lineId: number, script: string, start: number, end: number): DubScene => ({
    lineId,
    script,
    start,
    end
  })

  it('gives a single-scene line the whole text', () => {
    const out = dubCaptionLines([line(1, 'ทาทับกันได้ไม่เป็นคราบ', 0, 3)])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ start: 0, end: 3 })
    expect(out[0].text.replace(/\s+/g, '')).toBe('ทาทับกันได้ไม่เป็นคราบ')
  })

  // The failure the plan names: a caption that outlives its scene.
  it('clamps every caption to its own scene', () => {
    const out = dubCaptionLines([
      line(1, 'เปิดมาเจอสีนี้ก่อนเลย ตัวเนื้อบางแต่สีชัด', 0, 2),
      line(1, 'เปิดมาเจอสีนี้ก่อนเลย ตัวเนื้อบางแต่สีชัด', 2, 5)
    ])
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      const scene = [
        { start: 0, end: 2 },
        { start: 2, end: 5 }
      ].find((s) => s.start === c.start)
      expect(scene).toBeDefined()
      expect(c.end).toBe(scene!.end)
    }
  })

  it('splits a line across its scenes without losing or repeating words', () => {
    const script = 'หนึ่ง สอง สาม สี่ ห้า หก'
    const out = dubCaptionLines([line(1, script, 0, 3), line(1, script, 3, 6)])
    // Compared without spaces: Thai tokens rejoin with no separator (see
    // joinWords / caption.py), so only the characters must survive intact.
    const strip = (t: string): string => t.replace(/\s+/g, '')
    expect(
      out
        .map((c) => c.text)
        .map(strip)
        .join('')
    ).toBe(strip(script))
  })

  it('gives a longer scene more of the text', () => {
    const script = 'หนึ่ง สอง สาม สี่ ห้า หก เจ็ด แปด'
    const out = dubCaptionLines([line(1, script, 0, 8), line(1, script, 8, 10)])
    // Length in characters — Thai rejoins without spaces, so counting
    // space-delimited words would measure the wrong thing.
    const len = (t: string): number => t.replace(/\s+/g, '').length
    expect(len(out[0].text)).toBeGreaterThan(len(out[1].text))
  })

  it('never leaves a later scene with nothing when words remain', () => {
    // A long opening scene must not swallow the whole line.
    const out = dubCaptionLines([line(1, 'หนึ่ง สอง', 0, 20), line(1, 'หนึ่ง สอง', 20, 21)])
    expect(out).toHaveLength(2)
    expect(out[1].text.trim()).not.toBe('')
  })

  it('drops scenes it has no words left for rather than repeating text', () => {
    const out = dubCaptionLines([
      line(1, 'หนึ่ง', 0, 1),
      line(1, 'หนึ่ง', 1, 2),
      line(1, 'หนึ่ง', 2, 3)
    ])
    expect(out).toHaveLength(1)
  })

  it('keeps separate voiceover lines separate and in time order', () => {
    const out = dubCaptionLines([line(2, 'บรรทัดสอง', 5, 7), line(1, 'บรรทัดหนึ่ง', 0, 2)])
    expect(out.map((c) => c.start)).toEqual([0, 5])
  })

  it('ignores empty scripts and zero-length scenes', () => {
    expect(dubCaptionLines([line(1, '   ', 0, 3)])).toEqual([])
    expect(dubCaptionLines([line(1, 'มีข้อความ', 3, 3)])).toEqual([])
  })

  it('produces unique ids', () => {
    const out = dubCaptionLines([
      line(1, 'หนึ่ง สอง', 0, 2),
      line(1, 'หนึ่ง สอง', 2, 4),
      line(2, 'สาม สี่', 4, 6)
    ])
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length)
  })
})

describe('segmentWords', () => {
  it('splits Thai text that has no spaces', () => {
    // Thai writing has no inter-word spaces, so a naive split would give one token.
    expect(segmentWords('สวัสดีครับ').length).toBeGreaterThan(1)
  })

  it('returns nothing for blank input', () => {
    expect(segmentWords('   ')).toEqual([])
  })
})

describe('captionWordsFromLines', () => {
  it('spreads each line evenly across its own span', () => {
    const words = captionWordsFromLines([{ id: 'c0', text: 'a b c d', start: 0, end: 4 }])
    expect(words.map((w) => w.word)).toEqual(['a', 'b', 'c', 'd'])
    expect(words[0]).toMatchObject({ start: 0, end: 1 })
    expect(words[3]).toMatchObject({ start: 3, end: 4 })
  })

  it('splits Thai lines into real tokens — the whole reason this exists', () => {
    // Without this the burn-in falls back to a whitespace split, and a Thai
    // line "reveals" as one lump in word_pop / typewriter mode.
    const words = captionWordsFromLines([{ id: 'c0', text: 'สวัสดีครับ', start: 0, end: 2 }])
    expect(words.length).toBeGreaterThan(1)
    expect(words[words.length - 1].end).toBeCloseTo(2, 3)
  })

  it('skips lines with no span and no text', () => {
    expect(
      captionWordsFromLines([
        { id: 'c0', text: 'x', start: 1, end: 1 },
        { id: 'c1', text: '  ', start: 0, end: 2 }
      ])
    ).toEqual([])
  })
})

// ── SubRip stamps ────────────────────────────────────────────────────────────
describe('captionLinesToSrt', () => {
  it('never emits a ,1000 millisecond field', () => {
    // 1.9997s rounds to 2000ms: splitting the fraction on its own produced
    // "00:00:01,1000", which is not a valid SubRip stamp.
    const srt = captionLinesToSrt([{ id: 'a', text: 'x', start: 1.9997, end: 2.5 }])
    expect(srt).toContain('00:00:02,000 --> 00:00:02,500')
    expect(srt).not.toMatch(/,\d{4}/)
  })

  it('formats hours, minutes and milliseconds', () => {
    const srt = captionLinesToSrt([{ id: 'a', text: 'x', start: 3661.25, end: 3661.5 }])
    expect(srt).toContain('01:01:01,250 --> 01:01:01,500')
  })
})

// ── talking_head caption lines must be OUTPUT time (2026-09-07) ──────────────
//
// openEditor groups these lines and TimelineEditor's save writes them into
// timeline.captionLines, which the sidecar burns verbatim as output time
// (build_ass_captions' documented contract). They used to be grouped straight
// from timeline.words — SOURCE timestamps — so on a cut-down video every line
// was burned at its original timestamp, usually past the end of the clip.
describe('talking_head caption lines are on the output clock', () => {
  // A 60s source cut down to 25s of speech: 0-10 kept, 10-40 dropped, 40-55 kept.
  const words = Array.from({ length: 60 }, (_, i) => ({
    word: `w${i}`,
    start: i,
    end: i + 0.8
  }))
  const cuts: EditCut[] = [
    { id: 'a', source: 'clip0', in: 0, out: 10, label: '' },
    { id: 'b', source: 'clip0', in: 40, out: 55, label: '' }
  ]
  const outputDur = 25

  it('never produces a line past the end of the rendered video', () => {
    const lines = groupWordsIntoLines(remapWordsToOutput(words, cuts, clipAbsOffsets([60])))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l.start).toBeGreaterThanOrEqual(0)
      expect(l.end).toBeLessThanOrEqual(outputDur + 1e-6)
    }
  })

  it('would have produced lines past the end WITHOUT the remap', () => {
    // The regression this pins: grouping the raw source words.
    const lines = groupWordsIntoLines(words)
    expect(lines.some((l) => l.start >= outputDur)).toBe(true)
  })

  it('drops words the cut removed instead of shifting them', () => {
    const lines = groupWordsIntoLines(remapWordsToOutput(words, cuts, clipAbsOffsets([60])))
    const text = lines.map((l) => l.text).join(' ')
    // w20 is inside the removed 10-40s span.
    expect(text).not.toContain('w20')
    expect(text).toContain('w0')
    expect(text).toContain('w40')
  })

  it('places the second cut immediately after the first', () => {
    const remapped = remapWordsToOutput(words, cuts, clipAbsOffsets([60]))
    expect(remapped.find((w) => w.word === 'w40')!.start).toBeCloseTo(10, 6)
  })
})
