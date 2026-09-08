/**
 * The edit-script normalisation the render depends on.
 *
 * Pinned against `backend/packages/video/timeline.py:normalize_dub_edit_script`
 * (plus `annotate_dub_script_output_times`, which is its last step) and
 * `dub_render.py:write_dub_script_txt` — the two builds must agree, because a
 * segment the browser clamps differently is a cut in a different place, and a
 * script.txt with different timestamps sends the reader to the wrong moment.
 */

import { describe, expect, it } from 'vitest'
import { DUB_MIN_CUT_SEC, buildScriptTxt, normalizeDubEditScript } from './editScript'

describe('normalizeDubEditScript', () => {
  it('sorts by order, not by array position', () => {
    const out = normalizeDubEditScript({
      segments: [
        { order: 3, sourceIn: 6, sourceOut: 8 },
        { order: 1, sourceIn: 0, sourceOut: 2 },
        { order: 2, sourceIn: 3, sourceOut: 5 }
      ]
    })
    expect(out.segments?.map((s) => s.order)).toEqual([1, 2, 3])
    expect(out.segments?.map((s) => s.sourceIn)).toEqual([0, 3, 6])
  })

  it('lifts a segment shorter than the minimum cut', () => {
    const out = normalizeDubEditScript({
      segments: [{ order: 1, sourceIn: 1, sourceOut: 1.05 }]
    })
    expect(out.segments?.[0].durationSec).toBeCloseTo(DUB_MIN_CUT_SEC, 5)
  })

  it('does not rewrite the script it was given', () => {
    const input = {
      segments: [
        { order: 2, sourceIn: 3, sourceOut: 4 },
        { order: 1, sourceIn: 0, sourceOut: 1 }
      ]
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    normalizeDubEditScript(input)
    // The editor is showing this object; a render must not reorder it underneath.
    expect(input).toEqual(snapshot)
  })

  it('groups a continuation cut under the line it continues', () => {
    const out = normalizeDubEditScript({
      segments: [
        { order: 1, sourceIn: 0, sourceOut: 2, voiceoverScript: 'บรรทัดแรก' },
        // No text of its own: another angle on the line already being spoken.
        { order: 2, sourceIn: 4, sourceOut: 6 },
        { order: 3, sourceIn: 8, sourceOut: 9, voiceoverScript: 'บรรทัดสอง' }
      ]
    })
    expect(out.segments?.map((s) => s.voiceoverLineId)).toEqual([1, 1, 2])
    // …and it borrows the text, so captions and script.txt have no holes.
    expect(out.segments?.[1].voiceoverScript).toBe('บรรทัดแรก')
  })

  it('lays the segments out on the output clock', () => {
    const out = normalizeDubEditScript({
      segments: [
        { order: 1, sourceIn: 10, sourceOut: 12 },
        { order: 2, sourceIn: 30, sourceOut: 33 }
      ]
    })
    // Output times start at zero regardless of where the cuts came from.
    expect(out.segments?.map((s) => [s.outputIn, s.outputOut])).toEqual([
      [0, 2],
      [2, 5]
    ])
    expect(out.totalEstimatedSec).toBe(5)
  })

  it('spans a montage line across every cut that speaks it', () => {
    const out = normalizeDubEditScript({
      segments: [
        { order: 1, sourceIn: 0, sourceOut: 2, voiceoverScript: 'หนึ่ง' },
        { order: 2, sourceIn: 4, sourceOut: 6 },
        { order: 3, sourceIn: 8, sourceOut: 9, voiceoverScript: 'สอง' }
      ]
    })
    const [a, b, c] = out.segments ?? []
    expect([a.voiceoverLineOutputIn, a.voiceoverLineOutputOut]).toEqual([0, 4])
    expect([b.voiceoverLineOutputIn, b.voiceoverLineOutputOut]).toEqual([0, 4])
    expect([c.voiceoverLineOutputIn, c.voiceoverLineOutputOut]).toEqual([4, 5])
  })

  it('survives an empty script rather than throwing', () => {
    expect(normalizeDubEditScript({}).segments).toEqual([])
  })
})

describe('buildScriptTxt', () => {
  const script = normalizeDubEditScript({
    segments: [
      { order: 1, sourceIn: 0, sourceOut: 2, voiceoverScript: 'บรรทัดแรก' },
      { order: 2, sourceIn: 4, sourceOut: 6 },
      { order: 3, sourceIn: 8, sourceOut: 9, voiceoverScript: 'บรรทัดสอง' }
    ]
  })
  const segments = script.segments ?? []

  it('writes one entry per spoken line, not per cut', () => {
    const txt = buildScriptTxt(segments, null)
    expect(txt.match(/\[Line \d/g)).toHaveLength(2)
    expect(txt).toContain('บรรทัดแรก')
    expect(txt).toContain('บรรทัดสอง')
  })

  it('marks a line that was cut into more than one shot', () => {
    expect(buildScriptTxt(segments, null)).toContain('2 cuts')
  })

  it('times the lines on the output clock', () => {
    const txt = buildScriptTxt(segments, null)
    // The first line runs 0–4 s of the RENDER, not 0–6 s of the source.
    expect(txt).toContain('[Line 1 | 0.0s → 4.0s | 2 cuts]')
    expect(txt).toContain('[Line 2 | 4.0s → 5.0s]')
  })

  it('reports the finished length', () => {
    expect(buildScriptTxt(segments, null)).toContain('Total: 5s')
  })

  it('carries the brief when there is one', () => {
    expect(buildScriptTxt(segments, 'ความยาวเป้าหมาย: ~15 วิ')).toContain('~15 วิ')
    expect(buildScriptTxt(segments, null)).not.toContain('Brief:')
  })
})
