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
  findSegmentAt,
  fmtTime,
  fmtTimeTenths,
  mapSourceTimeToOutput,
  parseTimecode,
  removedSpanStats,
  rulerStepSec,
  cutBoundariesSec,
  snapCandidateToBeat,
  snapCaptionEdge,
  snapMusicOffsetToCut,
  snapToMarkers,
  timecodeCommitValue,
  sourceNeighborBounds,
  sourceNeighborBoundsById,
  splitCutAt,
  voiceoverLineBlocks,
  clipAbsOffsets,
  remapWordsToOutput,
  snapTrimToBeat,
  withDuplicate,
  withNewAngle,
  withNewScene,
  withReorder,
  insertIndexOutsideLineRuns,
  lineScriptDraft,
  lineScriptFor,
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

describe('findSegmentAt', () => {
  it('answers exactly as findEditedSegment, from segments laid out once', () => {
    const cuts = [
      cut('a', 's', 0, 2),
      cut('b', 's', 10, 12.5),
      cut('c', 't', 3, 3.1),
      cut('d', 's', 1, 4)
    ]
    const segs = computeEditedSegments(cuts)
    for (let i = -20; i <= 200; i++) {
      const t = i * 0.05
      const seg = findSegmentAt(segs, t)
      expect(seg).toEqual(findEditedSegment(cuts, t))
      // One of the segments it was given, not a copy.
      expect(segs).toContain(seg)
    }
  })

  it('hands a boundary, and the last millisecond before it, to the next scene', () => {
    const segs = computeEditedSegments([cut('a', 's', 0, 2), cut('b', 's', 10, 12)])
    expect(findSegmentAt(segs, 1.998)?.cut.id).toBe('a')
    expect(findSegmentAt(segs, 1.9995)?.cut.id).toBe('b')
    expect(findSegmentAt(segs, 2)?.cut.id).toBe('b')
  })

  it('has nothing to find in an empty list', () => {
    expect(findSegmentAt([], 1)).toBeNull()
  })
})

describe('sourceNeighborBoundsById', () => {
  it('gives every cut on the lane the bounds sourceNeighborBounds gives it', () => {
    const lane = [
      cut('a', 's', 4, 6),
      cut('b', 's', 0, 2),
      cut('c', 's', 2, 3),
      cut('d', 's', 8, 9),
      cut('e', 's', 4, 5)
    ]
    const bounds = sourceNeighborBoundsById(lane, 12)
    expect(bounds.size).toBe(lane.length)
    for (const c of lane) expect(bounds.get(c.id)).toEqual(sourceNeighborBounds(c, lane, 12))
  })

  it('agrees with the per-cut lookup on lanes with tied and nested cuts', () => {
    // Small deterministic generator — the same lanes on every run.
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let lane = 0; lane < 60; lane++) {
      const n = 1 + Math.floor(rand() * 8)
      const cuts = Array.from({ length: n }, (_, i) => {
        const tIn = Math.floor(rand() * 10) / 2
        return cut(`c${i}`, 's', tIn, tIn + Math.floor(1 + rand() * 6) / 2)
      })
      const dur = 5 + Math.floor(rand() * 10)
      const bounds = sourceNeighborBoundsById(cuts, dur)
      for (const c of cuts) expect(bounds.get(c.id)).toEqual(sourceNeighborBounds(c, cuts, dur))
    }
  })

  it('bounds a lone cut by the lane', () => {
    expect(sourceNeighborBoundsById([cut('a', 's', 3, 5)], 10).get('a')).toEqual({
      minIn: 0,
      maxOut: 10
    })
  })

  it('keeps a repeated id at its first place in lane order, as findIndex does', () => {
    const lane = [cut('x', 's', 5, 6), cut('y', 's', 0, 1), cut('x', 's', 2, 3)]
    expect(sourceNeighborBoundsById(lane, 10).get('x')).toEqual(
      sourceNeighborBounds(lane[0], lane, 10)
    )
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

describe('withNewScene', () => {
  const ids = (cuts: EditCut[]): string[] => cuts.map((c) => c.id)

  it('appends a dub scene as a new, empty voiceover line', () => {
    const prev = [cut('a', 's', 0, 2, 1), cut('b', 's', 5, 7, 3)]
    const next = withNewScene(prev, {
      id: 'new1',
      source: 's',
      start: 10,
      end: 12,
      isDub: true,
      atPlayhead: false
    })
    expect(ids(next)).toEqual(['a', 'b', 'new1'])
    expect(next[2]).toEqual({
      id: 'new1',
      source: 's',
      in: 10,
      out: 12,
      label: 'บรรทัด 4',
      voiceoverLineId: 4,
      voiceoverScript: ''
    })
    // The input list is left alone — it is still the undo step's state.
    expect(ids(prev)).toEqual(['a', 'b'])
  })

  it('gives a non-dub scene no voiceover line', () => {
    const [created] = withNewScene([], {
      id: 'new1',
      source: 's',
      start: 0,
      end: 2,
      isDub: false,
      atPlayhead: false
    })
    expect(created).toMatchObject({ label: 'ฉากใหม่', in: 0, out: 2 })
    expect(created.voiceoverLineId).toBeUndefined()
    expect(created.voiceoverScript).toBeUndefined()
  })

  it('at the playhead, goes before the first cut of its file that starts later', () => {
    const prev = [cut('a', 's', 0, 2), cut('x', 'other', 1, 3), cut('b', 's', 8, 9)]
    const at = (start: number, source = 's'): string[] =>
      ids(
        withNewScene(prev, {
          id: 'n',
          source,
          start,
          end: start + 1,
          isDub: false,
          atPlayhead: true
        })
      )
    expect(at(5)).toEqual(['a', 'x', 'n', 'b'])
    // A hair of tolerance: a scene starting where one already does goes first.
    expect(at(8.005)).toEqual(['a', 'x', 'n', 'b'])
    // Past every cut of its file: right after that file's last one.
    expect(at(20)).toEqual(['a', 'x', 'b', 'n'])
    // A file with no cuts yet: the end of the sequence.
    expect(at(0, 'fresh')).toEqual(['a', 'x', 'b', 'n'])
  })
})

describe('withNewAngle', () => {
  it("goes right after the line's last cut, numbered as its next angle", () => {
    const prev = [cut('a', 's', 0, 2, 1), cut('b', 's', 4, 5, 1), cut('c', 's', 9, 10, 2)]
    const next = withNewAngle(prev, { id: 'new1', source: 's2', lineId: 1, start: 3, end: 5 })
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'new1', 'c'])
    expect(next[2]).toEqual({
      id: 'new1',
      source: 's2',
      in: 3,
      out: 5,
      label: 'บรรทัด 1 · มุม 3',
      voiceoverLineId: 1,
      voiceoverScript: ''
    })
  })

  it('appends when the line has no cuts', () => {
    const next = withNewAngle([cut('a', 's', 0, 2, 1)], {
      id: 'n',
      source: 's',
      lineId: 5,
      start: 0,
      end: 2
    })
    expect(next.map((c) => c.id)).toEqual(['a', 'n'])
    expect(next[1].label).toBe('บรรทัด 5 · มุม 1')
  })
})

describe('withDuplicate', () => {
  it('puts a dub copy right after the original as a new line with its script', () => {
    const prev = [cut('a', 's', 0, 2, 1), cut('b', 's', 4, 5, 2)]
    const next = withDuplicate(prev, 'a', 'new1', true)
    expect(next?.map((c) => c.id)).toEqual(['a', 'new1', 'b'])
    expect(next?.[1]).toMatchObject({
      source: 's',
      in: 0,
      out: 2,
      label: 'บรรทัด 3',
      voiceoverLineId: 3,
      voiceoverScript: 'script 1'
    })
  })

  it('keeps the label and line of a non-dub copy', () => {
    const original = cut('a', 's', 0, 2, 1)
    const next = withDuplicate([original], 'a', 'new1', false)
    expect(next?.[1]).toEqual({ ...original, id: 'new1' })
  })

  it('leaves the AI shot metadata on the original only', () => {
    // A copy carrying `alternates` made ปรับช็อต ask the same question twice.
    const meta = {
      alternates: [{ sourceClip: 'clip0', sourceIn: 9, sourceOut: 11 }],
      swappedFrom: { sourceClip: 'clip0', sourceIn: 0, sourceOut: 2 }
    }
    const original = { ...cut('a', 's', 0, 2, 1), meta }
    const next = withDuplicate([original], 'a', 'new1', true)
    expect(next?.[0].meta).toBe(meta)
    expect(next?.[1].meta).toBeUndefined()
  })

  it('is null when the cut is gone, so no empty undo step is recorded', () => {
    expect(withDuplicate([cut('a', 's', 0, 2)], 'zzz', 'new1', true)).toBeNull()
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

  it('spans every scene the line covers, clamped to the clip, and drags stay inside them', () => {
    const [span] = captionChipSpansFromOutput(cuts, [
      { id: 'c1', text: 'spills', start: 3, end: 9 }
    ])
    expect(span).toMatchObject({ outStart: 3, durationSec: 3, cutIn: 0, cutOut: 6 })
  })

  // A talking_head line (three words, grouped regardless of cuts) straddling a
  // cut. The chip used to stop at the first scene's end, and a 1px nudge of its
  // right edge cut the REAL line down to that scene, dropping 3 s of it.
  it('a line straddling a cut keeps its whole length when its right edge is nudged', () => {
    const straddle = [cut('a', 's', 0, 1), cut('b', 's', 10, 14)] // output 0–1, 1–5
    const [span] = captionChipSpansFromOutput(straddle, [
      { id: 'c1', text: 'x', start: 0.5, end: 4 }
    ])
    expect(span).toMatchObject({ outStart: 0.5, durationSec: 3.5, cutIn: 0, cutOut: 5 })
    expect(dragCaptionEdge({ start: 0.5, end: 4 }, span, 'right', 0.01)).toEqual({
      start: 0.5,
      end: 4.01
    })
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

describe('snapCaptionEdge', () => {
  // A dub line starts ON a scene boundary. At 40 px/s the snap reaches 0.25 s,
  // so a right edge dragged to the 0.2 s minimum used to land on the line's own
  // start and the line vanished from the lane and the render.
  it('never snaps a line below the minimum length', () => {
    const patch = dragCaptionEdge({ start: 3, end: 7 }, { cutIn: 3, cutOut: 7 }, 'right', -99)
    expect(patch).toEqual({ start: 3, end: 3 + MIN_CAPTION_SEC })
    expect(snapCaptionEdge(patch, 'right', [0, 3, 7], 0.25)).toEqual(patch)
  })

  it('still snaps a dragged edge onto a nearby boundary', () => {
    expect(snapCaptionEdge({ start: 3, end: 6.9 }, 'right', [0, 3, 7], 0.25)).toEqual({
      start: 3,
      end: 7
    })
    expect(snapCaptionEdge({ start: 3.1, end: 6 }, 'left', [0, 3, 7], 0.25)).toEqual({
      start: 3,
      end: 6
    })
  })
})

describe('timecodeCommitValue', () => {
  // The field shows tenths; committing an untouched field floored the real
  // value (3.4667 → 3.4) and pulled a dub caption onto the previous scene.
  it('commits nothing when the text is what focus showed', () => {
    const shown = fmtTimeTenths(3.4667)
    expect(parseTimecode(shown)).toBe(3.4)
    expect(timecodeCommitValue(shown, shown)).toBeNull()
  })

  it('commits a typed value, and nothing for garbage', () => {
    expect(timecodeCommitValue('0:05.5', '0:03.4')).toBe(5.5)
    expect(timecodeCommitValue('abc', '0:03.4')).toBeNull()
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

describe('splitCutAt keeps AI shot metadata on the first half only', () => {
  it('does not offer the same alternates twice', async () => {
    const { splitCutAt } = await import('./timelineMath')
    const cuts: EditCut[] = [
      {
        id: 'cut0',
        source: 'clip0',
        in: 0,
        out: 4,
        label: '1',
        meta: { alternates: [{ note: 'x' }] }
      }
    ]
    const next = splitCutAt(cuts, 'cut0', 2, 'new1')
    expect(next?.[0].meta).toEqual({ alternates: [{ note: 'x' }] })
    expect(next?.[1].meta).toBeUndefined()
  })
})

// Bug hunt #13: a voiceover line's angles must stay next to each other, or its
// VO block and its render span swallow the lines in between.
describe('voiceover lines stay in one piece', () => {
  const ids = (cuts: EditCut[]): string[] => cuts.map((c) => c.id)
  const lines = (cuts: EditCut[]): (number | null | undefined)[] =>
    cuts.map((c) => c.voiceoverLineId)
  /** Every line's cuts are one contiguous run. */
  const contiguous = (cuts: EditCut[]): boolean => {
    const seen = new Set<number | null | undefined>()
    return cuts.every((c, i) => {
      const id = c.voiceoverLineId
      if (i > 0 && cuts[i - 1].voiceoverLineId === id) return true
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
  // L1 · L2 (two angles) · L3
  const base = (): EditCut[] => [
    cut('a', 's', 0, 2, 1),
    cut('b1', 's', 10, 12, 2),
    { ...cut('b2', 's', 20, 22, 2), voiceoverScript: '' },
    cut('c', 's', 30, 32, 3)
  ]

  it('insertIndexOutsideLineRuns moves an index out of a run, not between lines', () => {
    const cuts = base()
    expect(insertIndexOutsideLineRuns(cuts, 2)).toBe(3)
    expect(insertIndexOutsideLineRuns(cuts, 1)).toBe(1)
    expect(insertIndexOutsideLineRuns(cuts, 0)).toBe(0)
    expect(insertIndexOutsideLineRuns(cuts, 4)).toBe(4)
    // Cuts with no line never form a run.
    expect(insertIndexOutsideLineRuns([cut('x', 's', 0, 1), cut('y', 's', 1, 2)], 1)).toBe(1)
  })

  it('an angle dragged away from its line becomes a line of its own', () => {
    // The reproduction: second L2 angle moved to the end.
    const next = withReorder(base(), 'b2', 'c', true)!
    expect(ids(next)).toEqual(['a', 'b1', 'c', 'b2'])
    expect(next[3]).toMatchObject({ voiceoverLineId: 4, label: 'บรรทัด 4', voiceoverScript: '' })
    expect(contiguous(next)).toBe(true)
    // The VO lane no longer draws line 2 over line 3.
    const blocks = voiceoverLineBlocks(next)
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i].outStart).toBeGreaterThanOrEqual(
        blocks[i - 1].outStart + blocks[i - 1].durationSec - 1e-9
      )
    }
  })

  it("the line's script stays with the angles left behind", () => {
    const next = withReorder(base(), 'b1', 'c', true)!
    expect(ids(next)).toEqual(['a', 'b2', 'c', 'b1'])
    expect(lineScriptFor(next, 2)).toBe('script 2')
    expect(next[3]).toMatchObject({ voiceoverLineId: 4, voiceoverScript: '' })
  })

  it('a scene dropped between two angles of another line lands past that line', () => {
    // Dragged right onto b1's slot... then b2: past the whole line 2.
    expect(ids(withReorder(base(), 'a', 'b1', true)!)).toEqual(['b1', 'b2', 'a', 'c'])
    // Dragged left onto b2: in front of the whole line 2.
    expect(ids(withReorder(base(), 'c', 'b2', true)!)).toEqual(['a', 'c', 'b1', 'b2'])
    for (const [from, to] of [
      ['a', 'b1'],
      ['c', 'b2'],
      ['c', 'b1'],
      ['a', 'c']
    ]) {
      expect(contiguous(withReorder(base(), from, to, true)!)).toBe(true)
    }
  })

  it("reorders a line's own angles freely, and returns null for no move", () => {
    const next = withReorder(base(), 'b2', 'b1', true)!
    expect(ids(next)).toEqual(['a', 'b2', 'b1', 'c'])
    expect(lines(next)).toEqual([1, 2, 2, 3])
    expect(withReorder(base(), 'a', 'a', true)).toBeNull()
    expect(withReorder(base(), 'zzz', 'a', true)).toBeNull()
  })

  it('a non-dub reorder is a plain move', () => {
    expect(ids(withReorder(base(), 'b2', 'c', false)!)).toEqual(['a', 'b1', 'c', 'b2'])
  })

  it("a dub duplicate goes after the line's last angle", () => {
    const next = withDuplicate(base(), 'b1', 'new1', true)!
    expect(ids(next)).toEqual(['a', 'b1', 'b2', 'new1', 'c'])
    expect(contiguous(next)).toBe(true)
  })

  it("a new scene never lands between a line's angles", () => {
    // Source order would put a scene at 15 s between b1 (10) and b2 (20).
    const next = withNewScene(base(), {
      id: 'n',
      source: 's',
      start: 15,
      end: 17,
      isDub: true,
      atPlayhead: true
    })
    expect(ids(next)).toEqual(['a', 'b1', 'b2', 'n', 'c'])
  })
})

// Bug hunt #31: in the edited view N goes after the scene under the playhead,
// not wherever its source time falls in an AI-ordered cut.
describe('withNewScene after the scene under the playhead', () => {
  it('goes right after that scene, whatever the source order', () => {
    const prev = [cut('a', 's', 20, 22), cut('b', 's', 5, 7), cut('c', 's', 10, 12)]
    const next = withNewScene(prev, {
      id: 'new1',
      source: 's',
      start: 6,
      end: 8,
      isDub: false,
      atPlayhead: true,
      afterCutId: 'b'
    })
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'new1', 'c'])
  })

  it('an unknown scene falls back to the source-order rule', () => {
    const prev = [cut('a', 's', 20, 22), cut('b', 's', 5, 7)]
    const next = withNewScene(prev, {
      id: 'n',
      source: 's',
      start: 6,
      end: 8,
      isDub: false,
      atPlayhead: true,
      afterCutId: 'gone'
    })
    expect(next.map((c) => c.id)).toEqual(['n', 'a', 'b'])
  })
})

describe('lineScriptDraft', () => {
  it('keeps the spaces and new lines being typed; lineScriptFor trims', () => {
    const cuts = [{ ...cut('a', 's', 0, 2, 1), voiceoverScript: 'สวัสดี \nค่ะ ' }]
    expect(lineScriptDraft(cuts, 1)).toBe('สวัสดี \nค่ะ ')
    expect(lineScriptFor(cuts, 1)).toBe('สวัสดี \nค่ะ')
  })

  it('reads a script that lives on a later angle, and whitespace on the first', () => {
    const later = [
      { ...cut('a', 's', 0, 2, 1), voiceoverScript: '' },
      { ...cut('b', 's', 2, 4, 1), voiceoverScript: 'บท ' }
    ]
    expect(lineScriptDraft(later, 1)).toBe('บท ')
    const blank = [{ ...cut('a', 's', 0, 2, 1), voiceoverScript: '  ' }]
    expect(lineScriptDraft(blank, 1)).toBe('  ')
    expect(lineScriptDraft(blank, 9)).toBe('')
  })
})
