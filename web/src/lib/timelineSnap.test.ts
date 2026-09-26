import { describe, expect, it } from 'vitest'
import { FRAME_SEC, SNAP_THRESHOLD_PX } from '../components/timeline/constants'
import type { EditCut } from './editorApi'
import { MIN_CUT_SEC } from './timelineMath'
import {
  NO_SNAP,
  nearestTarget,
  quantizeToFrame,
  snapScrub,
  snapSpan,
  snapTolSec,
  snapTrimPatch,
  type SnapTarget
} from './timelineSnap'

const cut = (over: Partial<EditCut> = {}): EditCut => ({
  id: 'c1',
  source: 'clipA',
  in: 2,
  out: 5,
  label: 'ฉาก 1',
  ...over
})

const t = (sec: number, kind: SnapTarget['kind'] = 'cut', ownerId?: string): SnapTarget =>
  ownerId ? { sec, kind, ownerId } : { sec, kind }

describe('snapTolSec', () => {
  it('is 8 screen px converted at the current zoom', () => {
    expect(snapTolSec(40)).toBeCloseTo(0.2, 10)
    expect(snapTolSec(160)).toBeCloseTo(0.05, 10)
    expect(snapTolSec(40)).toBe(SNAP_THRESHOLD_PX / 40)
  })

  it('takes a custom pixel threshold and never divides by less than 1 px/s', () => {
    expect(snapTolSec(40, 6)).toBeCloseTo(0.15, 10)
    expect(snapTolSec(0, 8)).toBe(8)
  })
})

describe('nearestTarget', () => {
  const targets = [t(1), t(2), t(3)]

  it('finds the closest target inside the tolerance', () => {
    const hit = nearestTarget(2.1, targets, 0.2)
    expect(hit?.target.sec).toBe(2)
    expect(hit?.distSec).toBeCloseTo(-0.1, 10)
  })

  it('is strict: a target exactly at the tolerance does not snap', () => {
    expect(nearestTarget(2.2, targets, 0.2)).toBeNull()
    expect(nearestTarget(2.19, targets, 0.2)?.target.sec).toBe(2)
  })

  it('breaks a tie toward the earlier target', () => {
    const hit = nearestTarget(2.5, targets, 1)
    expect(hit?.target.sec).toBe(2)
  })

  it('skips excluded targets so a cut never snaps to its own edges', () => {
    const own = [t(2, 'cut', 'c1'), t(2.15, 'cut', 'c2')]
    const hit = nearestTarget(2.05, own, 0.2, (x) => x.ownerId === 'c1')
    expect(hit?.target.ownerId).toBe('c2')
    expect(nearestTarget(2.05, own, 0.2, () => true)).toBeNull()
  })

  it('returns null on an empty list', () => {
    expect(nearestTarget(1, [], 5)).toBeNull()
  })
})

describe('quantizeToFrame', () => {
  it('leaves a frame multiple exactly where it is', () => {
    expect(quantizeToFrame(0.3)).toBe(0.3)
    expect(quantizeToFrame(1)).toBe(1)
  })

  it('rounds to the nearest frame', () => {
    expect(quantizeToFrame(0.017)).toBeCloseTo(FRAME_SEC, 5)
    expect(quantizeToFrame(0.01)).toBe(0)
    expect(quantizeToFrame(0.04)).toBeCloseTo(FRAME_SEC, 5)
  })

  it('never goes below zero', () => {
    expect(quantizeToFrame(-0.5)).toBe(0)
    expect(quantizeToFrame(-0.001)).toBe(0)
  })

  it('takes a custom frame length', () => {
    expect(quantizeToFrame(0.26, 0.25)).toBe(0.25)
  })
})

describe('snapTrimPatch', () => {
  // Block starts at 10 s on the output clock; cut is 2..5 on its source.
  const startOffsetSec = 10

  it('right edge on the output clock lands the block END on a voiceover target', () => {
    const c = cut()
    // Dragging out to 4.3 puts the block end at 12.3; a VO line ends at 12.4.
    const { patch, hit } = snapTrimPatch({
      patch: { out: 4.3 },
      cut: c,
      edge: 'right',
      clock: 'output',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(12.4, 'voiceover')],
      tolSec: 0.2
    })
    expect(hit?.target.kind).toBe('voiceover')
    expect(patch.out).toBeCloseTo(c.in + (12.4 - startOffsetSec), 10)
    expect(patch.in).toBeUndefined()
  })

  it('left edge on the output clock moves the END too (the start is pinned)', () => {
    const c = cut()
    // Head-trim to in=2.3 → block length 2.7 → end at 12.7; target at 12.6.
    const { patch, hit } = snapTrimPatch({
      patch: { in: 2.3 },
      cut: c,
      edge: 'left',
      clock: 'output',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(12.6, 'voiceover')],
      tolSec: 0.2
    })
    expect(hit?.target.sec).toBe(12.6)
    expect(patch.in).toBeCloseTo(c.out - (12.6 - startOffsetSec), 10)
    expect(patch.out).toBeUndefined()
  })

  it('clamps AFTER snapping and reports no hit when the clamp moved it', () => {
    const c = cut()
    // A target that would leave a 0.1 s scene: block end at 10.1.
    const { patch, hit } = snapTrimPatch({
      patch: { out: c.in + 0.25 },
      cut: c,
      edge: 'right',
      clock: 'output',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(startOffsetSec + 0.1, 'cut')],
      tolSec: 0.2
    })
    expect(patch.out).toBeCloseTo(c.in + MIN_CUT_SEC, 10)
    expect(hit).toBeNull()
  })

  it('left edge clamp: never a negative in, hit null', () => {
    const c = cut({ in: 0.1, out: 3 })
    const { patch, hit } = snapTrimPatch({
      patch: { in: 0.05 },
      cut: c,
      edge: 'left',
      clock: 'source',
      startOffsetSec: 0,
      minIn: 0,
      maxOut: 20,
      targets: [t(-0.05, 'start')],
      tolSec: 0.2
    })
    expect(patch.in).toBe(0)
    expect(hit).toBeNull()
  })

  it('source clock snaps the raw edge value', () => {
    const c = cut()
    const right = snapTrimPatch({
      patch: { out: 4.9 },
      cut: c,
      edge: 'right',
      clock: 'source',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(5.05, 'cut', 'c2')],
      tolSec: 0.2
    })
    expect(right.patch.out).toBe(5.05)
    expect(right.hit?.target.ownerId).toBe('c2')

    const left = snapTrimPatch({
      patch: { in: 1.9 },
      cut: c,
      edge: 'left',
      clock: 'source',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(1.8, 'playhead')],
      tolSec: 0.2
    })
    expect(left.patch.in).toBe(1.8)
    expect(left.hit?.target.kind).toBe('playhead')
  })

  it('returns the patch clamped and no hit when nothing is in range', () => {
    const c = cut()
    const { patch, hit } = snapTrimPatch({
      patch: { out: 4.3 },
      cut: c,
      edge: 'right',
      clock: 'output',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(13, 'cut')],
      tolSec: 0.2
    })
    expect(patch).toEqual({ out: 4.3 })
    expect(hit).toBeNull()
  })

  it('passes a patch without the dragged edge through untouched', () => {
    const c = cut()
    const r = snapTrimPatch({
      patch: { in: 2.5 },
      cut: c,
      edge: 'right',
      clock: 'output',
      startOffsetSec,
      minIn: 0,
      maxOut: 20,
      targets: [t(12.5)],
      tolSec: 1
    })
    expect(r.patch).toEqual({ in: 2.5 })
    expect(r.hit).toBeNull()
  })
})

describe('snapSpan', () => {
  it('snaps the nearer edge and shifts both by the same amount', () => {
    const r = snapSpan({
      start: 1.15,
      end: 3.15,
      minStart: 0,
      maxEnd: 10,
      targets: [t(1), t(3.1)],
      tolSec: 0.2
    })
    // end is 0.05 from 3.1, start is 0.15 from 1 → end wins.
    expect(r.hit?.target.sec).toBe(3.1)
    expect(r.start).toBeCloseTo(1.1, 10)
    expect(r.end).toBeCloseTo(3.1, 10)
    expect(r.end - r.start).toBeCloseTo(2, 10)
  })

  it('uses the start when only it is in range', () => {
    const r = snapSpan({
      start: 1.05,
      end: 3.05,
      minStart: 0,
      maxEnd: 10,
      targets: [t(1)],
      tolSec: 0.2
    })
    expect(r.hit?.target.sec).toBe(1)
    expect(r.start).toBe(1)
    expect(r.end).toBe(3)
  })

  it('clamps to the bounds and drops the hit when the clamp moved it', () => {
    const r = snapSpan({
      start: 8.1,
      end: 10.1,
      minStart: 0,
      maxEnd: 10,
      targets: [t(10.2, 'end')],
      tolSec: 0.2
    })
    expect(r.start).toBe(8)
    expect(r.end).toBe(10)
    expect(r.hit).toBeNull()
  })

  it('clamps an unsnapped span too', () => {
    const r = snapSpan({ start: -1, end: 1, minStart: 0, maxEnd: 10, targets: [], tolSec: 0.2 })
    expect(r).toEqual({ start: 0, end: 2, hit: null })
  })
})

describe('snapScrub', () => {
  it('snaps to a playhead-style target inside the tolerance', () => {
    const r = snapScrub(4.96, [t(5, 'cut')], 0.15)
    expect(r.sec).toBe(5)
    expect(r.hit?.target.kind).toBe('cut')
  })

  it('leaves the candidate alone otherwise', () => {
    const r = snapScrub(4.5, [t(5, 'cut')], 0.15)
    expect(r).toEqual({ sec: 4.5, hit: null })
  })
})

describe('NO_SNAP', () => {
  it('never snaps and never throws', () => {
    expect(NO_SNAP.isActive()).toBe(false)
    expect(NO_SNAP.tolSec()).toBe(0)
    expect(NO_SNAP.outputTargets()).toEqual([])
    expect(NO_SNAP.sourceTargets('x')).toEqual([])
    expect(() => NO_SNAP.report(null, 'output')).not.toThrow()
  })
})
