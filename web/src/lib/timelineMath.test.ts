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
  MIN_CUT_SEC,
  rollCutBoundary,
  slipCut,
  nudgeCutEdge,
  withSceneMoved,
  withReorderMany,
  withCutsRemoved,
  idsBetween,
  pasteCuts,
  withRangeRemoved,
  isSkipped,
  withSkipToggled,
  fmtSignedSec,
  fmtFrames,
  fmtTimecodeFrames,
  rulerTicks
} from './timelineMath'
import { FRAME_SEC, MAX_PX_PER_SEC, MIN_PX_PER_SEC } from '../components/timeline/constants'

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

// ── editor-standard batch (2026-09-27): roll, slip, nudge, keyboard reorder,
// multi-move, batch delete, paste, range delete, skip, readouts, ruler ticks.

describe('rollCutBoundary', () => {
  // a plays 0–3 (source 2–5), b plays 3–5 (source 10–12); both clips 20 s long.
  const base = (): EditCut[] => [cut('a', 's', 2, 5), cut('b', 't', 10, 12), cut('c', 's', 7, 8)]
  const bounds = { leftMinIn: 0, leftMaxOut: 20, rightMinIn: 0, rightMaxOut: 20 }

  it('moves the left out and the right in by the same delta, total length unchanged', () => {
    const prev = base()
    const next = rollCutBoundary(prev, 'a', 0.5, bounds)!
    expect(next[0]).toMatchObject({ in: 2, out: 5.5 })
    expect(next[1]).toMatchObject({ in: 10.5, out: 12 })
    expect(next[2]).toBe(prev[2]) // the cut after the junction is untouched
    expect(computeEditedDuration(next)).toBeCloseTo(computeEditedDuration(base()), 9)
    const back = rollCutBoundary(base(), 'a', -0.5, bounds)!
    expect(back[0].out).toBeCloseTo(4.5)
    expect(back[1].in).toBeCloseTo(9.5)
  })

  it("is clamped by the left's source end, and both edges move by that smaller amount", () => {
    const next = rollCutBoundary(base(), 'a', 3, { ...bounds, leftMaxOut: 6 })!
    expect(next[0].out).toBe(6)
    expect(next[1].in).toBe(11)
    expect(computeEditedDuration(next)).toBeCloseTo(computeEditedDuration(base()), 9)
  })

  it('is clamped so the right scene keeps MIN_CUT_SEC', () => {
    const next = rollCutBoundary(base(), 'a', 5, bounds)!
    expect(next[1].out - next[1].in).toBeCloseTo(MIN_CUT_SEC)
    expect(next[0].out).toBeCloseTo(5 + (2 - MIN_CUT_SEC))
  })

  it('is clamped so the left scene keeps MIN_CUT_SEC and the right stays past rightMinIn', () => {
    const left = rollCutBoundary(base(), 'a', -5, bounds)!
    expect(left[0].out - left[0].in).toBeCloseTo(MIN_CUT_SEC)
    const neighbour = rollCutBoundary(base(), 'a', -5, { ...bounds, rightMinIn: 9.5 })!
    expect(neighbour[1].in).toBe(9.5)
    expect(neighbour[0].out).toBe(4.5)
  })

  it('has no junction after the last cut, and nothing to do for a zero delta', () => {
    expect(rollCutBoundary(base(), 'c', 1, bounds)).toBeNull()
    expect(rollCutBoundary(base(), 'zzz', 1, bounds)).toBeNull()
    expect(rollCutBoundary(base(), 'a', 0, bounds)).toBeNull()
    // Already at the limit: the clamp leaves nothing to move.
    expect(rollCutBoundary(base(), 'a', 1, { ...bounds, leftMaxOut: 5 })).toBeNull()
  })

  it('does not disturb the input list', () => {
    const prev = base()
    rollCutBoundary(prev, 'a', 0.5, bounds)
    expect(prev[0].out).toBe(5)
    expect(prev[1].in).toBe(10)
  })
})

describe('slipCut', () => {
  const c = cut('a', 's', 4, 6)

  it('shifts in and out together, keeping the duration', () => {
    expect(slipCut(c, 0.4, { minIn: 0, maxOut: 20 })).toEqual({ in: 4.4, out: 6.4 })
    expect(slipCut(c, -0.4, { minIn: 0, maxOut: 20 })).toEqual({ in: 3.6, out: 5.6 })
  })

  it('stops at both bounds', () => {
    expect(slipCut(c, -10, { minIn: 1, maxOut: 20 })).toEqual({ in: 1, out: 3 })
    expect(slipCut(c, 99, { minIn: 0, maxOut: 9 })).toEqual({ in: 7, out: 9 })
  })

  it('thirty frame-sized steps add up to a second, within float noise', () => {
    let w = { in: 0, out: 1 }
    for (let i = 0; i < 30; i += 1) w = slipCut(w, FRAME_SEC, { minIn: 0, maxOut: 10 })
    expect(w.in).toBeCloseTo(1, 9)
    expect(w.out).toBeCloseTo(2, 9)
  })

  it('leaves a window wider than its bounds alone', () => {
    expect(slipCut(c, 1, { minIn: 4.5, maxOut: 5.5 })).toEqual({ in: 4, out: 6 })
  })
})

describe('nudgeCutEdge', () => {
  const list = (): EditCut[] => [cut('a', 's', 4, 6), cut('b', 's', 8, 9)]
  const b = { minIn: 0, maxOut: 20 }

  it('moves one edge by a signed amount and leaves the other cut alone', () => {
    const right = nudgeCutEdge(list(), 'a', 'right', FRAME_SEC, b)!
    expect(right[0].out).toBeCloseTo(6 + FRAME_SEC, 6)
    expect(right[0].in).toBe(4)
    expect(right[1]).toEqual(list()[1])
    const left = nudgeCutEdge(list(), 'a', 'left', -10 * FRAME_SEC, b)!
    expect(left[0].in).toBeCloseTo(4 - 10 * FRAME_SEC, 6)
  })

  it('respects MIN_CUT_SEC and the outer bounds', () => {
    expect(nudgeCutEdge(list(), 'a', 'left', 5, b)![0].in).toBeCloseTo(6 - MIN_CUT_SEC)
    expect(nudgeCutEdge(list(), 'a', 'right', -5, b)![0].out).toBeCloseTo(4 + MIN_CUT_SEC)
    expect(nudgeCutEdge(list(), 'a', 'left', -5, { minIn: 3.5, maxOut: 20 })![0].in).toBe(3.5)
    expect(nudgeCutEdge(list(), 'a', 'right', 50, { minIn: 0, maxOut: 7 })![0].out).toBe(7)
  })

  it('is null when nothing changes', () => {
    expect(nudgeCutEdge(list(), 'a', 'right', 0, b)).toBeNull()
    expect(nudgeCutEdge(list(), 'a', 'right', 1, { minIn: 0, maxOut: 6 })).toBeNull()
    expect(nudgeCutEdge(list(), 'zzz', 'right', 1, b)).toBeNull()
  })
})

describe('withSceneMoved / withReorderMany', () => {
  const ids = (cuts: EditCut[] | null): string[] | null => cuts && cuts.map((c) => c.id)
  const plain = (): EditCut[] => [
    cut('a', 's', 0, 1),
    cut('b', 's', 2, 3),
    cut('c', 's', 4, 5),
    cut('d', 's', 6, 7),
    cut('e', 's', 8, 9)
  ]
  // L1 · L2 (two angles) · L3
  const dub = (): EditCut[] => [
    cut('a', 's', 0, 2, 1),
    cut('b1', 's', 10, 12, 2),
    { ...cut('b2', 's', 20, 22, 2), voiceoverScript: '' },
    cut('c', 's', 30, 32, 3)
  ]
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

  it('moves the first scene one slot later, and the last one cannot go later', () => {
    expect(ids(withSceneMoved(plain(), 'a', 1, false))).toEqual(['b', 'a', 'c', 'd', 'e'])
    expect(withSceneMoved(plain(), 'e', 1, false)).toBeNull()
  })

  it('moves a scene one slot earlier, and the first one cannot', () => {
    expect(ids(withSceneMoved(plain(), 'c', -1, false))).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(withSceneMoved(plain(), 'a', -1, false)).toBeNull()
    expect(withSceneMoved(plain(), 'zzz', -1, false)).toBeNull()
  })

  it("a dub scene moved later jumps over the whole of the next line's angles", () => {
    const next = withSceneMoved(dub(), 'a', 1, true)!
    expect(ids(next)).toEqual(['b1', 'b2', 'a', 'c'])
    expect(contiguous(next)).toBe(true)
  })

  it('a contiguous group of three moves before scene 1 as one unit', () => {
    expect(ids(withReorderMany(plain(), ['c', 'd', 'e'], 'a', false))).toEqual([
      'c',
      'd',
      'e',
      'a',
      'b'
    ])
    // Selection order does not matter, only play order.
    expect(ids(withReorderMany(plain(), ['e', 'c', 'd'], 'a', false))).toEqual([
      'c',
      'd',
      'e',
      'a',
      'b'
    ])
  })

  it('a group moved later lands after the scene it was dropped on', () => {
    expect(ids(withReorderMany(plain(), ['a', 'b'], 'd', false))).toEqual(['c', 'd', 'a', 'b', 'e'])
  })

  it('a non-contiguous selection is refused', () => {
    expect(withReorderMany(plain(), ['a', 'c'], 'e', false)).toBeNull()
  })

  it('a single id is a plain reorder; dropping on itself or on nothing is null', () => {
    expect(ids(withReorderMany(plain(), ['a'], 'c', false))).toEqual(
      ids(withReorder(plain(), 'a', 'c', false))
    )
    expect(withReorderMany(plain(), ['b', 'c'], 'c', false)).toBeNull()
    expect(withReorderMany(plain(), ['b', 'c'], 'zzz', false)).toBeNull()
    expect(withReorderMany(plain(), [], 'a', false)).toBeNull()
  })

  it("a dub group keeps another line's angles contiguous", () => {
    // a + b1 dragged onto b2's slot would split line 2 — the block lands past it.
    const next = withReorderMany(dub(), ['a', 'b1'], 'b2', true)
    expect(next).not.toBeNull()
    expect(contiguous(next!)).toBe(true)
    // Line 1 + line 3 dropped between line 2's angles: past the whole line.
    const later = withReorderMany([...dub(), cut('d', 's', 40, 41, 4)], ['c', 'd'], 'b1', true)!
    expect(ids(later)).toEqual(['a', 'c', 'd', 'b1', 'b2'])
    expect(contiguous(later)).toBe(true)
  })

  it('part of a line carried away becomes its own line, script staying behind', () => {
    // b2 + c moved to the front: b2 no longer touches b1, so it is a new line.
    const next = withReorderMany(dub(), ['b2', 'c'], 'a', true)!
    expect(ids(next)).toEqual(['b2', 'c', 'a', 'b1'])
    expect(contiguous(next)).toBe(true)
    expect(next[0]).toMatchObject({ voiceoverLineId: 4, voiceoverScript: '' })
    expect(lineScriptFor(next, 2)).toBe('script 2')
  })

  it('a whole line moved as a block keeps its line id', () => {
    const next = withReorderMany(dub(), ['b1', 'b2'], 'a', true)!
    expect(ids(next)).toEqual(['b1', 'b2', 'a', 'c'])
    expect(next[0].voiceoverLineId).toBe(2)
    expect(next[1].voiceoverLineId).toBe(2)
  })
})

describe('withCutsRemoved / idsBetween', () => {
  const list = (): EditCut[] => [cut('a', 's', 0, 1), cut('b', 's', 2, 3), cut('c', 's', 4, 5)]

  it('removes every matched id in one go', () => {
    expect(withCutsRemoved(list(), new Set(['a', 'c']))?.map((c) => c.id)).toEqual(['b'])
  })

  it('is null when nothing matched', () => {
    expect(withCutsRemoved(list(), new Set(['x']))).toBeNull()
    expect(withCutsRemoved(list(), new Set())).toBeNull()
  })

  it('idsBetween is inclusive and order-independent', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(idsBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(idsBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(idsBetween(order, 'c', 'c')).toEqual(['c'])
    expect(idsBetween(order, 'zzz', 'c')).toEqual(['c'])
    expect(idsBetween(order, 'zzz', 'yyy')).toEqual([])
  })
})

describe('pasteCuts', () => {
  const ids = (cuts: EditCut[]): string[] => cuts.map((c) => c.id)
  const counter = (): (() => string) => {
    let n = 0
    return () => `p${(n += 1)}`
  }
  const clip = (): EditCut[] => [
    { ...cut('x', 's', 0, 1), meta: { alternates: [{ note: 'x' }], skipped: true } },
    cut('y', 't', 5, 6)
  ]

  it('inserts fresh, meta-free copies after the given cut', () => {
    const prev = [cut('a', 's', 0, 1), cut('b', 's', 2, 3)]
    const next = pasteCuts(prev, 'a', clip(), counter(), false)
    expect(ids(next)).toEqual(['a', 'p1', 'p2', 'b'])
    expect(next[1]).toMatchObject({ source: 's', in: 0, out: 1, label: 'x' })
    expect(next[1].meta).toBeUndefined()
    expect(isSkipped(next[1])).toBe(false)
    expect(next[2]).toMatchObject({ source: 't', in: 5, out: 6 })
    // The clipboard and the list are left alone.
    expect(clip()[0].meta).toBeDefined()
    expect(ids(prev)).toEqual(['a', 'b'])
  })

  it('prepends for a null anchor and appends for a vanished one', () => {
    const prev = [cut('a', 's', 0, 1)]
    expect(ids(pasteCuts(prev, null, clip(), counter(), false))).toEqual(['p1', 'p2', 'a'])
    expect(ids(pasteCuts(prev, 'gone', clip(), counter(), false))).toEqual(['a', 'p1', 'p2'])
    expect(pasteCuts(prev, 'a', [], counter(), false)).toBe(prev)
  })

  it('joins the dub line of the cut before the insertion point as new angles', () => {
    const prev = [cut('a', 's', 0, 2, 1), cut('b1', 's', 10, 12, 2), cut('c', 's', 30, 32, 3)]
    const next = pasteCuts(prev, 'b1', clip(), counter(), true)
    expect(ids(next)).toEqual(['a', 'b1', 'p1', 'p2', 'c'])
    expect(next[2]).toMatchObject({
      voiceoverLineId: 2,
      voiceoverScript: '',
      label: 'บรรทัด 2 · มุม 2'
    })
    expect(next[3]).toMatchObject({ voiceoverLineId: 2, label: 'บรรทัด 2 · มุม 3' })
    expect(voiceoverLineBlocks(next).map((b) => b.lineId)).toEqual([1, 2, 3])
  })

  it('prepended dub copies join the first line; an empty list opens a new one', () => {
    const prev = [cut('a', 's', 0, 2, 1)]
    const front = pasteCuts(prev, null, clip(), counter(), true)
    expect(front.map((c) => c.voiceoverLineId)).toEqual([1, 1, 1])
    const fresh = pasteCuts([], null, clip(), counter(), true)
    expect(fresh.map((c) => c.voiceoverLineId)).toEqual([1, 1])
  })
})

describe('withRangeRemoved', () => {
  const ids = (cuts: EditCut[] | null): string[] | null => cuts && cuts.map((c) => c.id)
  // Output: a 0–3 (source 2–5), b 3–5 (source 10–12), c 5–8 (source 20–23).
  const list = (): EditCut[] => [cut('a', 's', 2, 5), cut('b', 's', 10, 12), cut('c', 's', 20, 23)]
  const counter = (): (() => string) => {
    let n = 0
    return () => `n${(n += 1)}`
  }

  it('a range inside one scene leaves two pieces', () => {
    const next = withRangeRemoved(list(), { inSec: 1, outSec: 2 }, counter())!
    expect(ids(next)).toEqual(['a', 'n1', 'b', 'c'])
    expect(next[0]).toMatchObject({ in: 2, out: 3 })
    expect(next[1]).toMatchObject({ in: 4, out: 5 })
    expect(computeEditedDuration(next)).toBeCloseTo(7)
  })

  it('a range spanning two scenes removes the middle', () => {
    // 2 s into a … 1 s into c: the whole of b goes, a and c are trimmed and
    // keep their ids (selection and filmstrip keys stay put).
    const next = withRangeRemoved(list(), { inSec: 2, outSec: 6 }, counter())!
    expect(ids(next)).toEqual(['a', 'c'])
    expect(next[0]).toMatchObject({ in: 2, out: 4 })
    expect(next[1]).toMatchObject({ source: 's', in: 21, out: 23 })
    expect(computeEditedDuration(next)).toBeCloseTo(4)
  })

  it('a range on exact boundaries removes whole scenes and splits nothing', () => {
    expect(ids(withRangeRemoved(list(), { inSec: 3, outSec: 5 }, counter()))).toEqual(['a', 'c'])
    expect(ids(withRangeRemoved(list(), { inSec: 0, outSec: 8 }, counter()))).toEqual([])
  })

  it('accepts the two ends in either order', () => {
    expect(ids(withRangeRemoved(list(), { inSec: 5, outSec: 3 }, counter()))).toEqual(['a', 'c'])
  })

  it('too short a range, or a remaining sliver, is refused', () => {
    expect(withRangeRemoved(list(), { inSec: 1, outSec: 1.1 }, counter())).toBeNull()
    // Would leave 0.1 s of a in front of the range.
    expect(withRangeRemoved(list(), { inSec: 0.1, outSec: 2 }, counter())).toBeNull()
    // Would leave 0.1 s of a after the range.
    expect(withRangeRemoved(list(), { inSec: 1, outSec: 2.9 }, counter())).toBeNull()
    // Nothing under the range at all.
    expect(withRangeRemoved(list(), { inSec: 20, outSec: 30 }, counter())).toBeNull()
  })

  it('trims a sliver the range grazes instead of making it a scene', () => {
    // 2.9–4: the last 0.1 s of a is trimmed off, the first 1 s of b removed.
    const next = withRangeRemoved(list(), { inSec: 2.9, outSec: 4 }, counter())!
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(next[0].out).toBeCloseTo(4.9)
    expect(next[1].in).toBeCloseTo(11)
    expect(computeEditedDuration(next)).toBeCloseTo(8 - 1.1)
  })

  it('makes up ids no cut has when the caller passes no counter', () => {
    const next = withRangeRemoved([...list(), cut('range-1', 's', 40, 41)], {
      inSec: 1,
      outSec: 2
    })!
    const all = next.map((c) => c.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('leaves skipped scenes where they are', () => {
    const skipped = withSkipToggled(list(), 'b')
    // Output is now a 0–3, c 3–6.
    const next = withRangeRemoved(skipped, { inSec: 2, outSec: 4 }, counter())!
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(isSkipped(next[1])).toBe(true)
    expect(next[0].out).toBe(4)
    expect(next[2].in).toBe(21)
  })
})

describe('skipped scenes', () => {
  const list = (): EditCut[] => [cut('a', 's', 0, 2), cut('b', 's', 10, 13), cut('c', 's', 20, 21)]

  it('a skipped scene has no segment and later scenes start earlier', () => {
    const next = withSkipToggled(list(), 'b')
    const segs = computeEditedSegments(next)
    expect(segs.map((s) => s.cut.id)).toEqual(['a', 'c'])
    expect(segs[1]).toMatchObject({ editedIn: 2, editedOut: 3 })
    expect(new Map(segs.map((s) => [s.cut.id, s.editedIn])).get('b')).toBeUndefined()
    expect(computeEditedDuration(next)).toBe(3)
    expect(cutBoundariesSec(next)).toEqual([0, 2, 3])
    expect(findEditedSegment(next, 2.5)?.cut.id).toBe('c')
    expect(mapSourceTimeToOutput(next, 11)).toBeNull()
  })

  it('a skipped angle drops out of its voiceover line block and its caption chips', () => {
    const dub = [cut('a', 's', 0, 2, 1), cut('b', 's', 10, 13, 1), cut('c', 's', 20, 21, 2)]
    const next = withSkipToggled(dub, 'b')
    expect(voiceoverLineBlocks(next)[0]).toMatchObject({ lineId: 1, durationSec: 2, cutCount: 1 })
    expect(captionChipSpans(next, [{ id: 'x', text: 'x', start: 11, end: 12 }])).toEqual([])
    expect(
      captionChipSpansFromOutput(next, [{ id: 'y', text: 'y', start: 2, end: 3 }])[0]
    ).toMatchObject({
      outStart: 2,
      durationSec: 1
    })
  })

  it('toggling twice restores the cut byte for byte', () => {
    const prev = list()
    const once = withSkipToggled(prev, 'b')
    expect(isSkipped(once[1])).toBe(true)
    expect(isSkipped(once[0])).toBe(false)
    expect(withSkipToggled(once, 'b')).toEqual(prev)
    expect('meta' in withSkipToggled(once, 'b')[1]).toBe(true)
    expect(withSkipToggled(once, 'b')[1].meta).toBeUndefined()
  })

  it('keeps the rest of meta across a skip and back', () => {
    const withMeta = [{ ...cut('a', 's', 0, 2), meta: { alternates: [{ note: 'x' }] } }]
    const on = withSkipToggled(withMeta, 'a')
    expect(on[0].meta).toEqual({ alternates: [{ note: 'x' }], skipped: true })
    expect(withSkipToggled(on, 'a')[0].meta).toEqual({ alternates: [{ note: 'x' }] })
    expect(withSkipToggled(withMeta, 'zzz')).toEqual(withMeta)
  })
})

describe('frame and delta formatting', () => {
  it('fmtSignedSec', () => {
    expect(fmtSignedSec(0.4)).toBe('+0.40 วิ')
    expect(fmtSignedSec(-0.07)).toBe('−0.07 วิ')
    expect(fmtSignedSec(0)).toBe('0.00 วิ')
    expect(fmtSignedSec(-0.001)).toBe('0.00 วิ')
    expect(fmtSignedSec(NaN)).toBe('0.00 วิ')
  })

  it('fmtFrames rounds to whole frames', () => {
    expect(fmtFrames(0.4)).toBe('+12 เฟรม')
    expect(fmtFrames(-FRAME_SEC)).toBe('−1 เฟรม')
    expect(fmtFrames(0)).toBe('0 เฟรม')
    expect(fmtFrames(29 / 30)).toBe('+29 เฟรม')
    expect(fmtFrames(0.5, 25)).toBe('+13 เฟรม')
  })

  it('fmtTimecodeFrames is m:ss:ff with frame 29 the last of a second', () => {
    expect(fmtTimecodeFrames(0)).toBe('0:00:00')
    expect(fmtTimecodeFrames(7.4)).toBe('0:07:12')
    expect(fmtTimecodeFrames(29 / 30)).toBe('0:00:29')
    expect(fmtTimecodeFrames(29.5 / 30)).toBe('0:01:00')
    expect(fmtTimecodeFrames(65 + 5 / 30)).toBe('1:05:05')
    expect(fmtTimecodeFrames(-1)).toBe('0:00:00')
    expect(fmtTimecodeFrames(NaN)).toBe('0:00:00')
  })
})

describe('rulerTicks', () => {
  it('keeps rulerStepSec for the labels', () => {
    expect(rulerTicks(40, 10).stepSec).toBe(rulerStepSec(40))
    expect(rulerTicks(40, 10).majors).toEqual([0, 5, 10])
    expect(rulerTicks(40, 11).majors).toEqual([0, 5, 10, 15])
  })

  it('subdivides so there is something between labels at 160 px/s', () => {
    const t = rulerTicks(MAX_PX_PER_SEC, 2)
    expect(t.stepSec).toBe(1)
    expect(t.subStepSec).toBeCloseTo(0.1)
    expect(t.minors.length).toBeGreaterThan(t.majors.length)
  })

  it('minors never coincide with majors and stay ≥ 6 px apart at every zoom', () => {
    for (const px of [MIN_PX_PER_SEC, 8.7, 20, 40, 80, MAX_PX_PER_SEC]) {
      const t = rulerTicks(px, 90)
      const majors = new Set(t.majors)
      for (const m of t.minors) expect(majors.has(m)).toBe(false)
      expect(t.subStepSec * px).toBeGreaterThanOrEqual(6)
      for (let i = 1; i < t.minors.length; i += 1) {
        expect((t.minors[i] - t.minors[i - 1]) * px).toBeGreaterThanOrEqual(6 - 1e-6)
      }
      expect(Math.max(...t.majors)).toBeGreaterThanOrEqual(90)
    }
  })

  it('has one label and no minors for an empty edit', () => {
    expect(rulerTicks(40, 0)).toMatchObject({ majors: [0], minors: [] })
    expect(rulerTicks(40, NaN).majors).toEqual([0])
  })
})
