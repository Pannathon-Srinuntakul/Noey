import { describe, expect, it } from 'vitest'
import type { EditCut } from './editorApi'
import {
  captionChipSpans,
  captionChipSpansFromOutput,
  computeEditedDuration,
  computeEditedSegments,
  dragCaptionEdge,
  MIN_CAPTION_SEC,
  findEditedSegment,
  fmtTime,
  fmtTimeTenths,
  mapSourceTimeToOutput,
  parseTimecode,
  removedSpanStats,
  rulerStepSec,
  cutBoundariesSec,
  snapCandidateToBeat,
  snapMusicOffsetToCut,
  snapToMarkers,
  splitCutAt,
  voiceoverLineBlocks,
  clipAbsOffsets,
  remapWordsToOutput,
  snapTrimToBeat,
  MIN_CUT_SEC
} from './timelineMath'

function cut(id: string, source: string, tIn: number, tOut: number, lineId?: number): EditCut {
  return {
    id,
    source,
    in: tIn,
    out: tOut,
    label: lineId ? String(lineId) : id,
    voiceoverLineId: lineId ?? null,
    voiceoverScript: lineId ? `script ${lineId}` : null
  }
}

describe('edited segments', () => {
  it('lays cuts back-to-back', () => {
    const segs = computeEditedSegments([cut('a', 's', 5, 8), cut('b', 's', 20, 21)])
    expect(segs[0]).toMatchObject({ editedIn: 0, editedOut: 3 })
    expect(segs[1]).toMatchObject({ editedIn: 3, editedOut: 4 })
    expect(computeEditedDuration([cut('a', 's', 5, 8), cut('b', 's', 20, 21)])).toBe(4)
  })

  it('findEditedSegment picks the containing cut, clamping past the end', () => {
    const cuts = [cut('a', 's', 0, 2), cut('b', 's', 10, 12)]
    expect(findEditedSegment(cuts, 1)?.cut.id).toBe('a')
    expect(findEditedSegment(cuts, 3)?.cut.id).toBe('b')
    expect(findEditedSegment(cuts, 99)?.cut.id).toBe('b')
  })
})

describe('splitCutAt', () => {
  it('splits into two cuts sharing the boundary; script stays on the first', () => {
    const next = splitCutAt([cut('a', 's', 2, 6, 1)], 'a', 4, 'new1')
    expect(next).not.toBeNull()
    expect(next![0]).toMatchObject({ id: 'a', in: 2, out: 4, voiceoverScript: 'script 1' })
    expect(next![1]).toMatchObject({ id: 'new1', in: 4, out: 6, voiceoverScript: '' })
  })

  it('refuses a split that leaves a sliver', () => {
    expect(splitCutAt([cut('a', 's', 2, 6)], 'a', 2.05, 'n')).toBeNull()
    expect(splitCutAt([cut('a', 's', 2, 6)], 'a', 5.95, 'n')).toBeNull()
  })
})

describe('voiceoverLineBlocks', () => {
  it("merges a line's angles into one contiguous block", () => {
    const cuts = [cut('a', 's', 0, 2, 1), cut('b', 's', 10, 11, 1), cut('c', 's', 20, 23, 2)]
    const blocks = voiceoverLineBlocks(cuts)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ lineId: 1, outStart: 0, durationSec: 3, cutCount: 2 })
    expect(blocks[1]).toMatchObject({ lineId: 2, outStart: 3, durationSec: 3, cutCount: 1 })
  })
})

describe('mapSourceTimeToOutput / captionChipSpans', () => {
  const cuts = [cut('a', 's', 10, 14), cut('b', 's', 30, 32)]

  it('maps kept footage and rejects removed footage', () => {
    expect(mapSourceTimeToOutput(cuts, 12)).toBe(2)
    expect(mapSourceTimeToOutput(cuts, 31)).toBe(5)
    expect(mapSourceTimeToOutput(cuts, 20)).toBeNull()
  })

  it('clamps a caption chip to its containing cut', () => {
    const spans = captionChipSpans(cuts, [
      { id: 'c1', text: 'x', start: 12, end: 20 },
      { id: 'c2', text: 'y', start: 0, end: 5 }
    ])
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ id: 'c1', outStart: 2, durationSec: 2 })
  })
})

describe('removedSpanStats', () => {
  it('counts gaps before, between and after cuts', () => {
    const stats = removedSpanStats(
      [cut('a', 's', 5, 10), cut('b', 's', 20, 30)],
      [{ id: 's', durationSec: 60 }]
    )
    expect(stats.removedCount).toBe(3)
    expect(stats.keptSec).toBe(15)
    expect(stats.totalSec).toBe(60)
  })
})

describe('rulerStepSec', () => {
  it('gives 5s labels at the default 40px/วิ and coarsens when zoomed out', () => {
    expect(rulerStepSec(40)).toBe(5)
    expect(rulerStepSec(10)).toBe(15)
    expect(rulerStepSec(300)).toBe(0.5)
  })
})

describe('formatting', () => {
  it('fmtTime + fmtTimeTenths', () => {
    expect(fmtTime(65)).toBe('1:05')
    expect(fmtTimeTenths(7.56)).toBe('0:07.5')
  })
})

describe('snapCandidateToBeat', () => {
  it('snaps within the threshold, honouring music offset/trim', () => {
    // beat at 10s of the track, trimmed in 2s, block starts at 1s → plays at 9s
    expect(snapCandidateToBeat(9.1, [10], true, 1, 2)).toBe(9)
    expect(snapCandidateToBeat(9.5, [10], true, 1, 2)).toBe(9.5)
    expect(snapCandidateToBeat(9.1, [10], false, 1, 2)).toBe(9.1)
  })
})

describe('cutBoundariesSec', () => {
  it('returns 0 plus every cut end on the output clock', () => {
    expect(cutBoundariesSec([cut('a', 's', 5, 8), cut('b', 's', 20, 21)])).toEqual([0, 3, 4])
  })

  it('is empty with no cuts', () => {
    expect(cutBoundariesSec([])).toEqual([])
  })
})

describe('snapToMarkers', () => {
  it('takes the nearest marker inside the threshold and leaves the rest alone', () => {
    expect(snapToMarkers(3.05, [0, 3, 7], 0.2)).toBe(3)
    expect(snapToMarkers(3.4, [0, 3, 7], 0.2)).toBe(3.4)
    expect(snapToMarkers(5, [], 0.2)).toBe(5)
  })
})

describe('snapMusicOffsetToCut', () => {
  it('shifts the track so a beat lands on a cut', () => {
    // beat at 2s of the track, no trim, dragged to offset 1.1 → beat plays at
    // 3.1s; the cut at 3s is 0.1 away, so the whole track moves back to 1.0.
    expect(snapMusicOffsetToCut(1.1, [2], [0, 3, 7], 0, 0.2)).toBeCloseTo(1)
  })

  it('accounts for the trim-in when placing the beat', () => {
    // same beat but the first 0.5s of the track is trimmed off
    expect(snapMusicOffsetToCut(1.6, [2], [0, 3, 7], 0.5, 0.2)).toBeCloseTo(1.5)
  })

  it('leaves the offset alone when nothing is within the threshold', () => {
    expect(snapMusicOffsetToCut(1.1, [2], [0, 9], 0, 0.2)).toBe(1.1)
  })

  it('passes through when there is no beat or cut data', () => {
    expect(snapMusicOffsetToCut(1.1, null, [0, 3], 0, 0.2)).toBe(1.1)
    expect(snapMusicOffsetToCut(1.1, [2], [], 0, 0.2)).toBe(1.1)
  })

  it('never returns a negative offset', () => {
    expect(snapMusicOffsetToCut(0.05, [2], [0], 0, 5)).toBe(0)
  })
})

describe('parseTimecode', () => {
  it('accepts m:ss.s, h:mm:ss and bare seconds', () => {
    expect(parseTimecode('0:22.4')).toBeCloseTo(22.4)
    expect(parseTimecode('1:02')).toBe(62)
    expect(parseTimecode('1:00:05')).toBe(3605)
    expect(parseTimecode('22.4')).toBeCloseTo(22.4)
  })

  it('rejects anything that is not a time rather than becoming 0', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('-3')).toBeNull()
    expect(parseTimecode('0:99')).toBeNull()
  })
})

describe('dragCaptionEdge', () => {
  const span = { cutIn: 10, cutOut: 14 }

  it('moves the dragged edge and leaves the other alone', () => {
    expect(dragCaptionEdge({ start: 11, end: 13 }, span, 'left', -0.5)).toEqual({
      start: 10.5,
      end: 13
    })
    expect(dragCaptionEdge({ start: 11, end: 13 }, span, 'right', 0.5)).toEqual({
      start: 11,
      end: 13.5
    })
  })

  it('never lets a caption escape its own scene', () => {
    expect(dragCaptionEdge({ start: 11, end: 13 }, span, 'left', -5).start).toBe(10)
    expect(dragCaptionEdge({ start: 11, end: 13 }, span, 'right', 5).end).toBe(14)
  })

  it('keeps a minimum length rather than collapsing the chip', () => {
    const r = dragCaptionEdge({ start: 11, end: 13 }, span, 'left', 99)
    expect(r.start).toBeCloseTo(13 - MIN_CAPTION_SEC)
  })
})

describe('captionChipSpansFromOutput', () => {
  // dub_first captions are laid along the FINISHED cut, so their times are
  // output times. Feeding them to the source-time version dropped all but the
  // one line that happened to fall inside a cut's source range — a 20-line
  // project drew a single chip (live 2026-08-13).
  const cuts = [cut('a', 's', 10, 14), cut('b', 's', 30, 32)] // output 0–4, 4–6

  it('keeps every line that lands on the output timeline', () => {
    const spans = captionChipSpansFromOutput(cuts, [
      { id: 'c1', text: 'one', start: 0, end: 2 },
      { id: 'c2', text: 'two', start: 2, end: 4 },
      { id: 'c3', text: 'three', start: 4, end: 6 }
    ])
    expect(spans.map((s) => s.id)).toEqual(['c1', 'c2', 'c3'])
    expect(spans[0]).toMatchObject({ outStart: 0, durationSec: 2 })
    expect(spans[2]).toMatchObject({ outStart: 4, durationSec: 2 })
  })

  it('clamps a line to the scene it starts in, and drags stay inside it', () => {
    const [span] = captionChipSpansFromOutput(cuts, [
      { id: 'c1', text: 'spills', start: 3, end: 9 }
    ])
    expect(span).toMatchObject({ outStart: 3, durationSec: 1, cutIn: 0, cutOut: 4 })
  })

  it('the same lines read as source time would nearly all vanish', () => {
    const lines = [
      { id: 'c1', text: 'one', start: 0, end: 2 },
      { id: 'c2', text: 'two', start: 2, end: 4 }
    ]
    expect(captionChipSpans(cuts, lines)).toHaveLength(0)
    expect(captionChipSpansFromOutput(cuts, lines)).toHaveLength(2)
  })
})

// ── caption clock (talking_head captions burned at the wrong time, 2026-09-07)
//
// `remapWordsToOutput` must agree with `remap_words_to_output` in
// backend/packages/video/caption.py word for word — the editor groups lines
// with the TS one and the sidecar burns them with the Python one. The expected
// values below were produced by running the Python function on this exact
// input; regenerate them the same way if the arithmetic ever has to change.
describe('clipAbsOffsets', () => {
  it('lays clips end to end on the source clock', () => {
    expect(clipAbsOffsets([30.5, 12])).toEqual({ clip0: 0, clip1: 30.5 })
  })

  it('is all zeroes for a single clip — why this never showed up before', () => {
    expect(clipAbsOffsets([30.5])).toEqual({ clip0: 0 })
  })
})

describe('remapWordsToOutput', () => {
  const words = [
    { word: 'หนึ่ง', start: 0.5, end: 1.0 },
    { word: 'สอง', start: 1.2, end: 1.8 },
    { word: 'สาม', start: 4.0, end: 4.6 },
    { word: 'four', start: 31.0, end: 31.5 },
    { word: 'five', start: 33.2, end: 34.4 },
    { word: 'six', start: 40.0, end: 41.0 }
  ]
  const cuts = [
    { id: 'a', source: 'clip0', in: 0.4, out: 2.0, label: '' },
    { id: 'b', source: 'clip1', in: 0.5, out: 4.0, label: '' },
    { id: 'c', source: 'clip0', in: 3.5, out: 5.0, label: '' }
  ]
  const offs = { clip0: 0, clip1: 30.5 }

  it('matches caption.py byte for byte on a two-clip, three-cut timeline', () => {
    expect(remapWordsToOutput(words, cuts, offs)).toEqual([
      { word: 'หนึ่ง', start: 0.1, end: 0.6 },
      { word: 'สอง', start: 0.8, end: 1.4 },
      { word: 'four', start: 1.6, end: 2.1 },
      { word: 'five', start: 3.8, end: 5.0 },
      { word: 'สาม', start: 5.6, end: 6.2 }
    ])
  })

  it('drops words that fall in material the cut removed', () => {
    // "six" at source 40-41 is inside no cut of clip0, so it never appears.
    expect(remapWordsToOutput(words, cuts, offs).some((w) => w.word === 'six')).toBe(false)
  })

  it('clips a word that straddles a cut edge to that edge', () => {
    const straddle = [{ word: 'yes', start: 1.5, end: 3.0 }]
    const one = [{ id: 'a', source: 'clip0', in: 0, out: 2.0, label: '' }]
    expect(remapWordsToOutput(straddle, one, { clip0: 0 })).toEqual([
      { word: 'yes', start: 1.5, end: 2.0 }
    ])
  })

  it('is the identity when a single cut covers the whole clip from 0', () => {
    const one = [{ id: 'a', source: 'clip0', in: 0, out: 60, label: '' }]
    expect(remapWordsToOutput(words.slice(0, 3), one, { clip0: 0 })).toEqual(words.slice(0, 3))
  })

  it('ignores a zero-length cut instead of emitting a zero-width window', () => {
    const bad = [
      { id: 'a', source: 'clip0', in: 1, out: 1, label: '' },
      { id: 'b', source: 'clip0', in: 0, out: 2, label: '' }
    ]
    expect(remapWordsToOutput(words, bad, { clip0: 0 })).toEqual([
      { word: 'หนึ่ง', start: 0.5, end: 1.0 },
      { word: 'สอง', start: 1.2, end: 1.8 }
    ])
  })
})

// ── the ภาพ lane must line up with the ruler (2026-09-07) ────────────────────
//
// Scene blocks sit in a flex row with shrink-0, so a per-block minimum width
// does not just widen one block — it SHIFTS every block after it. With a 24px
// floor, พอดีจอ on a 40-scene 2-minute project (~8.7 px/s, so anything under
// 2.8s hit the floor) pushed the lane over a hundred pixels right of the ruler
// mark it claimed to be under, and clicking the scene under the playhead
// selected a different one. Block width is now exact; the floor lives in an
// overlay that overhangs instead.
describe('scene lane width', () => {
  const blockWidth = (c: EditCut, pxPerSec: number): number => (c.out - c.in) * pxPerSec

  const cuts: EditCut[] = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`,
    source: 'clip0',
    in: i * 3,
    out: i * 3 + 2, // 2s each — under the old 24px floor at fit-to-screen zoom
    label: ''
  }))

  it('sums to the same length the ruler and playhead are drawn from', () => {
    for (const pxPerSec of [4, 8.7, 40, 160]) {
      const laneWidth = cuts.reduce((n, c) => n + blockWidth(c, pxPerSec), 0)
      expect(laneWidth).toBeCloseTo(computeEditedDuration(cuts) * pxPerSec, 6)
    }
  })

  it('puts each block where its own segment starts on the output clock', () => {
    const pxPerSec = 8.7
    const segs = computeEditedSegments(cuts)
    let x = 0
    segs.forEach((seg, i) => {
      expect(x).toBeCloseTo(seg.editedIn * pxPerSec, 6)
      x += blockWidth(cuts[i]!, pxPerSec)
    })
  })

  it('would have drifted with the old floor — the regression this pins', () => {
    const pxPerSec = 8.7
    const floored = cuts.reduce((n, c) => n + Math.max(blockWidth(c, pxPerSec), 24), 0)
    const exact = computeEditedDuration(cuts) * pxPerSec
    expect(floored - exact).toBeGreaterThan(100)
  })
})

// ── beat snap must not undo the trim clamp (2026-09-07) ──────────────────────
//
// bindTrimDrag clamps, then hands the value to the snap. A snap of up to
// BEAT_SNAP_THRESHOLD_SEC could push it straight back out of bounds, and
// nothing downstream re-checks: dubSegmentsFromEditCuts passes in/out through
// into sourceIn/sourceOut and trim_one_segment hands them to ffmpeg as-is.
describe('snapTrimToBeat', () => {
  const base = {
    cut: { in: 0.05, out: 3.0 },
    startOffsetSec: 0,
    maxOut: 10,
    snapEnabled: true,
    musicOffsetSec: 0,
    musicTrimInSec: 0,
    beatsSec: [3.15]
  }

  it('passes the patch straight through when snapping is off', () => {
    const p = { in: 0 }
    expect(snapTrimToBeat({ ...base, patch: p, snapEnabled: false })).toBe(p)
    expect(snapTrimToBeat({ ...base, patch: p, beatsSec: null })).toBe(p)
    expect(snapTrimToBeat({ ...base, patch: p, beatsSec: [] })).toBe(p)
  })

  it('never produces a negative sourceIn', () => {
    // Left handle dragged past the start: bindTrimDrag clamps to in=0, then the
    // beat at 3.15 pulls the end later, which the old code turned into
    // in = 3.0 - 3.15 = -0.15 and saved verbatim.
    const out = snapTrimToBeat({ ...base, patch: { in: 0 } })
    expect(out.in).toBeGreaterThanOrEqual(0)
  })

  it('never leaves a scene shorter than MIN_CUT_SEC from the left edge', () => {
    const out = snapTrimToBeat({ ...base, patch: { in: 0 }, beatsSec: [0.1] })
    expect(base.cut.out - out.in!).toBeGreaterThanOrEqual(MIN_CUT_SEC - 1e-9)
  })

  it('never leaves a scene shorter than MIN_CUT_SEC from the right edge', () => {
    // Right handle dragged to the floor, then a beat just before it.
    const cut = { in: 1.0, out: 1.2 }
    const out = snapTrimToBeat({
      ...base,
      cut,
      patch: { out: 1.2 },
      startOffsetSec: 0,
      beatsSec: [0.05]
    })
    expect(out.out! - cut.in).toBeGreaterThanOrEqual(MIN_CUT_SEC - 1e-9)
  })

  it('never lets a right-edge snap run past the source clip', () => {
    const out = snapTrimToBeat({
      ...base,
      cut: { in: 0, out: 9.9 },
      patch: { out: 9.9 },
      maxOut: 10,
      beatsSec: [10.05]
    })
    expect(out.out!).toBeLessThanOrEqual(10)
  })

  it('still snaps when the result stays in bounds', () => {
    // The cut's END on the OUTPUT clock is startOffset + (out - in) = 2.95,
    // not 3.0 — that offset is exactly what the snap has to account for.
    // A beat at 3.0 is 0.05 away, inside the threshold, so the end moves there
    // and `out` becomes in + 3.0.
    const out = snapTrimToBeat({ ...base, patch: { out: 3.0 }, beatsSec: [3.0] })
    expect(out.out).toBeCloseTo(3.05, 6)
  })

  it('leaves a beat outside the threshold alone', () => {
    // End on the output clock is 2.95; a beat at 3.3 is 0.35 away, well past
    // BEAT_SNAP_THRESHOLD_SEC, so the drag stands as the user left it.
    const out = snapTrimToBeat({ ...base, patch: { out: 3.0 }, beatsSec: [3.3] })
    expect(out.out).toBeCloseTo(3.0, 6)
  })

  it('snaps the left edge by moving the END onto the beat', () => {
    // Dragging `in` changes the duration, so it is the cut's END on the output
    // clock that lands on the beat — in = out - (beat - startOffset).
    const out = snapTrimToBeat({ ...base, patch: { in: 0.2 }, beatsSec: [2.9] })
    expect(out.in).toBeCloseTo(0.1, 6)
  })
})
