import { describe, expect, it } from 'vitest'
import type { DubEditScript, DubTimeline } from './videosLocalApi'
import {
  applySwapsToScript,
  countShotsWithAlternates,
  retimeTimelineForSwap,
  scriptTotalSec,
  segmentAlternates,
  segmentSwappedFrom,
  segmentWindow,
  swapCandidates,
  swapRegimeFor,
  swapSegment,
  windowFitsLocked,
  type ShotWindow
} from './shotSwap'

function seg(
  sourceIn: number,
  sourceOut: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    order: 1,
    voiceoverLineId: 1,
    sourceClip: 'clip0',
    sourceIn,
    sourceOut,
    durationSec: Math.round((sourceOut - sourceIn) * 100) / 100,
    matchedFrameTime: sourceIn,
    visualDescription: 'x',
    cutStyle: 'jump_cut',
    ...extra
  }
}

const alt = (sourceIn: number, sourceOut: number, note = 'ต่างมุม'): Record<string, unknown> => ({
  sourceClip: 'clip0',
  sourceIn,
  sourceOut,
  matchedFrameTime: sourceIn + 0.5,
  note
})

describe('swapRegimeFor', () => {
  it('locks only a dub with a recorded voiceover', () => {
    expect(swapRegimeFor('dub_first', undefined)).toBe('free')
    expect(swapRegimeFor('dub_first', 'vo.wav')).toBe('locked')
    expect(swapRegimeFor('highlight', 'anything')).toBe('free')
  })
})

describe('segmentAlternates', () => {
  it('parses and caps at three, tolerating garbage', () => {
    const s = seg(10, 13, {
      alternates: [alt(20, 23), null, 'x', alt(30, 34), alt(40, 42), alt(50, 53)]
    })
    const alts = segmentAlternates(s)
    expect(alts).toHaveLength(3)
    expect(alts[0]).toEqual({
      sourceClip: 'clip0',
      sourceIn: 20,
      sourceOut: 23,
      matchedFrameTime: 20.5,
      note: 'ต่างมุม'
    })
  })

  it('is empty for pre-R18b segments', () => {
    expect(segmentAlternates(seg(10, 13))).toEqual([])
  })
})

describe('countShotsWithAlternates', () => {
  it('counts only the shots that pose a question', () => {
    // The number the entry button shows and the length of the review queue:
    // a cut with three shots but one alternative is ONE question, not three.
    expect(countShotsWithAlternates({ segments: [] })).toBe(0)
    expect(countShotsWithAlternates({ segments: [seg(10, 13)] })).toBe(0)
    expect(
      countShotsWithAlternates({
        segments: [seg(10, 13), seg(20, 22, { alternates: [alt(30, 33)] }), seg(40, 42)]
      })
    ).toBe(1)
  })

  it('ignores an alternates array that survived with nothing usable in it', () => {
    expect(countShotsWithAlternates({ segments: [seg(10, 13, { alternates: [] })] })).toBe(0)
    expect(
      countShotsWithAlternates({ segments: [seg(10, 13, { alternates: [{ note: 'x' }] })] })
    ).toBe(0)
  })
})

describe('swapSegment — free regime', () => {
  it('adopts the natural window whole and keeps swappedFrom', () => {
    const out = swapSegment(seg(10, 12.6), toWindow(alt(30, 33.1)), 'free')!
    expect(out.sourceIn).toBe(30)
    expect(out.sourceOut).toBe(33.1)
    expect(out.durationSec).toBeCloseTo(3.1)
    expect(out.swappedFrom).toEqual({
      sourceClip: 'clip0',
      sourceIn: 10,
      sourceOut: 12.6,
      matchedFrameTime: 10,
      durationSec: 2.6
    })
    expect(segmentSwappedFrom(out)).toEqual({
      sourceClip: 'clip0',
      sourceIn: 10,
      sourceOut: 12.6,
      matchedFrameTime: 10
    })
  })
})

function toWindow(a: Record<string, unknown>): ShotWindow {
  return {
    sourceClip: String(a.sourceClip),
    sourceIn: Number(a.sourceIn),
    sourceOut: Number(a.sourceOut),
    matchedFrameTime: Number(a.matchedFrameTime)
  }
}

describe('swapSegment — locked regime', () => {
  it('trims to the original duration anchored at matchedFrameTime', () => {
    // dur 2.6, window 760.9–764.0, mft 761.4 → in = clamp(761.2, 760.9, 761.4) = 761.2
    const win: ShotWindow = {
      sourceClip: 'clip1',
      sourceIn: 760.9,
      sourceOut: 764.0,
      matchedFrameTime: 761.4
    }
    const out = swapSegment(seg(728.0, 730.6), win, 'locked')!
    expect(out.sourceIn).toBeCloseTo(761.2)
    expect(out.sourceOut).toBeCloseTo(763.8)
    expect(out.durationSec).toBeCloseTo(2.6)
    expect(out.sourceClip).toBe('clip1')
  })

  it('clamps the anchor to the window end when mft sits late', () => {
    const win: ShotWindow = {
      sourceClip: 'clip0',
      sourceIn: 50,
      sourceOut: 53,
      matchedFrameTime: 52.9
    }
    const out = swapSegment(seg(10, 12.6), win, 'locked')!
    expect(out.sourceIn).toBeCloseTo(50.4) // hi = 53 - 2.6
    expect(out.sourceOut).toBeCloseTo(53)
  })

  it('refuses a window shorter than the original duration', () => {
    const win: ShotWindow = {
      sourceClip: 'clip0',
      sourceIn: 50,
      sourceOut: 52.2,
      matchedFrameTime: 51
    }
    expect(windowFitsLocked(win, 2.6)).toBe(false)
    expect(swapSegment(seg(10, 12.6), win, 'locked')).toBeNull()
  })
})

describe('applySwapsToScript', () => {
  const script: DubEditScript = {
    mode: 'dub_first',
    totalEstimatedSec: 5.6,
    segments: [seg(10, 12.6, { alternates: [alt(30, 33.1)] }), seg(20, 23)]
  }

  it('free swap moves the total by exactly the difference', () => {
    const { script: out, applied } = applySwapsToScript(
      script,
      [{ segIndex: 0, window: toWindow(alt(30, 33.1)) }],
      'free'
    )
    expect(applied).toHaveLength(1)
    expect(scriptTotalSec(out)).toBeCloseTo(3.1 + 3)
    expect(out.totalEstimatedSec).toBeCloseTo(6.1)
    // untouched segment identical; input not mutated
    expect(out.segments[1]).toEqual(script.segments[1])
    expect(script.segments[0].swappedFrom).toBeUndefined()
  })

  it('locked swap keeps the total identical', () => {
    const { script: out } = applySwapsToScript(
      script,
      [{ segIndex: 0, window: toWindow(alt(30, 33.1)) }],
      'locked'
    )
    expect(scriptTotalSec(out)).toBeCloseTo(scriptTotalSec(script))
  })

  it('selecting the current window again is a no-op (diff stays empty)', () => {
    const { applied } = applySwapsToScript(
      script,
      [{ segIndex: 0, window: toWindow({ ...alt(10, 12.6), matchedFrameTime: 10 }) }],
      'free'
    )
    expect(applied).toHaveLength(0)
  })
})

describe('retimeTimelineForSwap', () => {
  it('re-points only the swapped cut, keeping its VO-scaled length', () => {
    const oldSegs = [seg(10, 12.6), seg(20, 23)]
    const { script: patched } = applySwapsToScript(
      { segments: oldSegs.map((s) => ({ ...s })) },
      [{ segIndex: 0, window: toWindow(alt(30, 33.1)) }],
      'locked'
    )
    const timeline: DubTimeline = {
      mode: 'dub_first',
      timeline: [
        { type: 'cut', source: 'clip0', in: 10.1, out: 12.5, label: 'opening' }, // 2.4s scaled
        { type: 'cut', source: 'clip0', in: 20, out: 23, label: 'conclusion' }
      ]
    }
    const { timeline: out, missed } = retimeTimelineForSwap(oldSegs, patched.segments, timeline)
    expect(missed).toEqual([])
    const c0 = out.timeline[0]
    expect(c0.out - c0.in).toBeCloseTo(2.4)
    expect(c0.in).toBeGreaterThanOrEqual(30)
    expect(c0.out).toBeLessThanOrEqual(33.1)
    expect(out.timeline[1]).toEqual(timeline.timeline[1])
  })

  it('leaves an unrelated cut alone and reports the swap it could not place', () => {
    const oldSegs = [seg(10, 12.6)]
    const newSegs = [seg(30, 32.6, { swappedFrom: { sourceIn: 10, sourceOut: 12.6 } })]
    const timeline: DubTimeline = {
      mode: 'dub_first',
      timeline: [{ type: 'cut', source: 'clip0', in: 90, out: 92, label: 'opening' }]
    }
    const { timeline: out, missed } = retimeTimelineForSwap(oldSegs, newSegs, timeline)
    expect(out.timeline[0]).toEqual(timeline.timeline[0])
    // Reported, so the caller refuses instead of rendering the old shot as done.
    expect(missed).toEqual([0])
  })

  it('follows a cut the planner nudged outside the segment window', () => {
    // Music attached: the planner moves boundaries toward beats. The old
    // containment check skipped this cut and the final kept the old shot.
    const oldSegs = [seg(5, 7.5)]
    const { script: patched } = applySwapsToScript(
      { segments: oldSegs.map((s) => ({ ...s })) },
      [{ segIndex: 0, window: toWindow(alt(20, 23)) }],
      'locked'
    )
    const timeline: DubTimeline = {
      mode: 'dub_first',
      timeline: [{ type: 'cut', source: 'clip0', in: 4.8, out: 7.5, label: 'a' }]
    }
    const { timeline: out, missed } = retimeTimelineForSwap(oldSegs, patched.segments, timeline)
    expect(missed).toEqual([])
    const c = out.timeline[0]
    expect(c.out - c.in).toBeCloseTo(2.7)
    const after = segmentWindow(patched.segments[0])
    expect(c.in).toBeCloseTo(after.sourceIn - 0.2)
  })

  it('matches by footage, not index, after the post-voiceover editor reordered and split', () => {
    const oldSegs = [seg(10, 12), seg(20, 23)]
    const { script: patched } = applySwapsToScript(
      { segments: oldSegs.map((s) => ({ ...s })) },
      [{ segIndex: 1, window: toWindow(alt(40, 44)) }],
      'locked'
    )
    const timeline: DubTimeline = {
      mode: 'dub_first',
      timeline: [
        { type: 'cut', source: 'clip0', in: 20, out: 21.5, label: 'b1' },
        { type: 'cut', source: 'clip0', in: 21.5, out: 23, label: 'b2' },
        { type: 'cut', source: 'clip0', in: 10, out: 12, label: 'a' }
      ]
    }
    const { timeline: out, missed } = retimeTimelineForSwap(oldSegs, patched.segments, timeline)
    expect(missed).toEqual([])
    const start = segmentWindow(patched.segments[1]).sourceIn
    expect(out.timeline[0]).toMatchObject({ in: start, out: start + 1.5 })
    expect(out.timeline[1].in).toBeCloseTo(start + 1.5)
    expect(out.timeline[2]).toEqual(timeline.timeline[2])
  })
})

describe('swapCandidates', () => {
  it('offers the backups before any swap', () => {
    const s = seg(10, 12.6, { alternates: [alt(30, 33), alt(40, 43)] })
    const c = swapCandidates(s)
    expect(c.map((x) => [x.window.sourceIn, x.original])).toEqual([
      [30, false],
      [40, false]
    ])
  })

  it("offers the AI's original back after a swap, never the shot in use", () => {
    const s = seg(10, 12.6, { alternates: [alt(30, 33), alt(40, 43)] })
    const swapped = swapSegment(s, toWindow(alt(30, 33)), 'free')!
    const c = swapCandidates(swapped)
    expect(c.map((x) => [x.window.sourceIn, x.original])).toEqual([
      [10, true],
      [40, false]
    ])
  })

  it('keeps the first original across a second swap, and clears it on the way back', () => {
    const s = seg(10, 12.6, { alternates: [alt(30, 33), alt(40, 43)] })
    const once = swapSegment(s, toWindow(alt(30, 33)), 'free')!
    const twice = swapSegment(once, toWindow(alt(40, 43)), 'free')!
    expect(segmentSwappedFrom(twice)).toMatchObject({ sourceIn: 10, sourceOut: 12.6 })
    const back = swapSegment(twice, segmentSwappedFrom(twice)!, 'free')!
    expect(back.swappedFrom).toBeUndefined()
    expect(back).toMatchObject({ sourceIn: 10, sourceOut: 12.6 })
  })
})
