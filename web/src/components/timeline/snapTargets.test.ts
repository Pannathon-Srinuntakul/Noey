import { describe, expect, it } from 'vitest'
import type { EditCut } from '../../lib/editorApi'
import { snapCandidateToBeat, voiceoverLineBlocks } from '../../lib/timelineMath'
import { beatsOnOutputClock, buildOutputTargets, buildSourceTargets } from './snapTargets'

const cut = (
  id: string,
  source: string,
  inSec: number,
  outSec: number,
  line?: number
): EditCut => ({
  id,
  source,
  in: inSec,
  out: outSec,
  label: id,
  voiceoverLineId: line,
  voiceoverScript: ''
})

// Three scenes: 0–2, 2–5, 5–6 on the output clock.
const cuts = [cut('a', 'clip0', 1, 3, 1), cut('b', 'clip1', 0, 3, 1), cut('c', 'clip0', 10, 11, 2)]

const base = {
  cuts,
  voBlocks: [],
  capSpans: [],
  music: null,
  beats: null,
  markers: [],
  range: null,
  playheadSec: 3.3,
  editedDur: 6
}

const secsOf = (targets: { sec: number; kind: string }[], kind: string): number[] =>
  targets.filter((t) => t.kind === kind).map((t) => t.sec)

describe('buildOutputTargets', () => {
  it('has the start, every scene boundary, the playhead and the end', () => {
    const t = buildOutputTargets(base)
    expect(secsOf(t, 'start')).toEqual([0])
    expect(secsOf(t, 'cut')).toEqual([2, 5, 6])
    expect(secsOf(t, 'playhead')).toEqual([3.3])
    expect(secsOf(t, 'end')).toEqual([6])
    // Each boundary names the scene that ends there.
    expect(t.find((x) => x.kind === 'cut' && x.sec === 5)?.ownerId).toBe('b')
  })

  it('includes every voiceover line start AND end (the owner ask)', () => {
    const voBlocks = voiceoverLineBlocks(cuts)
    // Line 1 = scenes a+b (0–5), line 2 = scene c (5–6).
    const t = buildOutputTargets({ ...base, voBlocks })
    expect(secsOf(t, 'voiceover')).toEqual([0, 5, 5, 6])
  })

  it('includes caption chip edges, the music block and the markers', () => {
    const t = buildOutputTargets({
      ...base,
      capSpans: [{ outStart: 1.2, durationSec: 0.8 }],
      music: { offsetSec: 0.5, trimInSec: 2, trimOutSec: 5 },
      markers: [{ id: 'm1', sec: 4.4 }]
    })
    expect(secsOf(t, 'caption')).toEqual([1.2, 2])
    expect(secsOf(t, 'music')).toEqual([0.5, 3.5])
    expect(secsOf(t, 'marker')).toEqual([4.4])
    expect(t.find((x) => x.kind === 'marker')?.ownerId).toBe('m1')
  })

  it('uses the decoded track length when the music has no trim-out', () => {
    const t = buildOutputTargets({
      ...base,
      music: { offsetSec: 1, trimInSec: 0, trimOutSec: null },
      musicDurationSec: 4
    })
    expect(secsOf(t, 'music')).toEqual([1, 5])
  })

  it('drops the dragged scene’s own two boundaries and keeps the rest', () => {
    const t = buildOutputTargets({ ...base, excludeCutId: 'b' })
    // b spans 2–5: both gone; a's start (0) and c's end (6) stay.
    expect(secsOf(t, 'cut')).toEqual([6])
    expect(secsOf(t, 'start')).toEqual([0])
    expect(secsOf(t, 'end')).toEqual([6])
  })

  it('drops a voiceover or caption edge that sits on the dragged scene’s boundary', () => {
    // Line 1 ends where scene b ends (5): derived from the cuts, so while b's
    // out-point is being dragged that edge is the handle's previous position.
    const t = buildOutputTargets({
      ...base,
      voBlocks: voiceoverLineBlocks(cuts),
      capSpans: [{ outStart: 2, durationSec: 1 }],
      excludeCutId: 'b'
    })
    expect(secsOf(t, 'voiceover')).toEqual([0, 6])
    expect(secsOf(t, 'caption')).toEqual([3])
  })

  it('includes the I/O range edges when set', () => {
    const t = buildOutputTargets({ ...base, range: { inSec: 1.5, outSec: 4 } })
    expect(secsOf(t, 'range')).toEqual([1.5, 4])
  })

  it('maps beats exactly as the old snapCandidateToBeat did', () => {
    const beats = [0.5, 1, 2.5, 4, 7]
    const music = { offsetSec: 0.25, trimInSec: 1, trimOutSec: null }
    const t = buildOutputTargets({ ...base, music, musicDurationSec: 10, beats })
    const mapped = secsOf(t, 'beat')
    // A beat before trim-in maps below 0, plays nowhere and is not a target.
    expect(mapped).toEqual([0.25, 1.75, 3.25, 6.25])
    // Every mapped beat is where the old snap would have pulled a candidate
    // that sits right on it.
    for (const sec of mapped) {
      expect(snapCandidateToBeat(sec + 0.01, beats, true, 0.25, 1)).toBeCloseTo(sec, 9)
    }
    expect(beatsOnOutputClock(beats, 1, 0.25)).toEqual(mapped)
  })

  it('has no beat targets without a track', () => {
    const t = buildOutputTargets({ ...base, beats: [1, 2] })
    expect(secsOf(t, 'beat')).toEqual([])
  })
})

describe('buildSourceTargets', () => {
  it('lists the other scenes on that file, the file ends and the playhead when it is that file', () => {
    const t = buildSourceTargets({
      cuts,
      sourceId: 'clip0',
      laneDurationSec: 30,
      playheadSec: 7,
      previewSource: 'clip0',
      excludeCutId: 'a'
    })
    expect(secsOf(t, 'start')).toEqual([0])
    expect(secsOf(t, 'cut')).toEqual([10, 11])
    expect(secsOf(t, 'playhead')).toEqual([7])
    expect(secsOf(t, 'end')).toEqual([30])
  })

  it('leaves out the playhead when the preview is on another file', () => {
    const t = buildSourceTargets({
      cuts,
      sourceId: 'clip1',
      laneDurationSec: 20,
      playheadSec: 7,
      previewSource: 'clip0'
    })
    expect(secsOf(t, 'playhead')).toEqual([])
    expect(secsOf(t, 'cut')).toEqual([0, 3])
  })
})
