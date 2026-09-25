import { describe, expect, it } from 'vitest'
import type { EditCut } from '../../lib/editorApi'
import { computeEditedSegments } from '../../lib/timelineMath'
import {
  editedTimeIn,
  followScrollLeft,
  nextBoundary,
  resolveEditedPosition,
  sceneIsOver
} from './previewMath'

const cut = (id: string, source: string, inSec: number, outSec: number): EditCut => ({
  id,
  source,
  in: inSec,
  out: outSec,
  label: ''
})

describe('editedTimeIn', () => {
  it('maps a source-local time onto the edited clock', () => {
    expect(editedTimeIn(10, { in: 4, out: 8 }, 5.5)).toBeCloseTo(11.5)
  })

  it('never runs past the scene, so the playhead does not jump into the next one', () => {
    // A playing element read a frame after its out-point.
    expect(editedTimeIn(10, { in: 4, out: 8 }, 8.03)).toBe(14)
    expect(editedTimeIn(10, { in: 4, out: 8 }, 3)).toBe(10)
  })
})

describe('sceneIsOver', () => {
  it('plays the whole scene: not over 50 ms before the out-point', () => {
    expect(sceneIsOver(7.95, { out: 8 }, 60)).toBe(false)
    expect(sceneIsOver(7.99, { out: 8 }, 60)).toBe(false)
    expect(sceneIsOver(8, { out: 8 }, 60)).toBe(true)
    expect(sceneIsOver(8.02, { out: 8 }, 60)).toBe(true)
  })

  it('ends a scene where its file ends when the stored out-point is past it', () => {
    expect(sceneIsOver(19.98, { out: 20.04 }, 19.98)).toBe(true)
  })

  it('ignores a duration the element does not know yet', () => {
    expect(sceneIsOver(5, { out: 8 }, NaN)).toBe(false)
    expect(sceneIsOver(8, { out: 8 }, 0)).toBe(true)
  })
})

describe('resolveEditedPosition', () => {
  const cuts = [cut('a', 's1', 0, 4), cut('b', 's2', 10, 13), cut('c', 's1', 20, 25)]

  it('keeps the frame of a scene that still exists', () => {
    const pos = resolveEditedPosition(computeEditedSegments(cuts), 'b', 11.5, 99)
    expect(pos?.seg.cut.id).toBe('b')
    expect(pos?.local).toBeCloseTo(11.5)
    expect(pos?.t).toBeCloseTo(5.5)
  })

  it('moves the playhead with its scene when a scene before it is deleted', () => {
    const after = cuts.filter((c) => c.id !== 'a')
    const pos = resolveEditedPosition(computeEditedSegments(after), 'b', 11.5, 5.5)
    expect(pos?.seg.cut.id).toBe('b')
    expect(pos?.t).toBeCloseTo(1.5)
  })

  it('lands on the scene now under the clock when its own scene was deleted', () => {
    // Playhead 2 s into b (t = 6), b deleted: t = 6 is now 2 s into c.
    const after = cuts.filter((c) => c.id !== 'b')
    const pos = resolveEditedPosition(computeEditedSegments(after), 'b', 12, 6)
    expect(pos?.seg.cut.id).toBe('c')
    expect(pos?.local).toBeCloseTo(22)
    expect(pos?.t).toBeCloseTo(6)
  })

  it('clamps a clock past the new end onto the last frame', () => {
    const after = [cuts[0]]
    const pos = resolveEditedPosition(computeEditedSegments(after), 'c', 22, 9)
    expect(pos?.seg.cut.id).toBe('a')
    expect(pos?.local).toBe(4)
    expect(pos?.t).toBe(4)
  })

  it('re-resolves when the frame was trimmed out of its scene', () => {
    const trimmed = [cut('a', 's1', 0, 4), cut('b', 's2', 12, 13), cut('c', 's1', 20, 25)]
    const pos = resolveEditedPosition(computeEditedSegments(trimmed), 'b', 10.5, 4.5)
    expect(pos?.seg.cut.id).toBe('b')
    expect(pos?.local).toBeCloseTo(12.5)
  })

  it('tolerates a playing element a frame past the out-point', () => {
    const pos = resolveEditedPosition(computeEditedSegments(cuts), 'a', 4.03, 4)
    expect(pos?.seg.cut.id).toBe('a')
    expect(pos?.local).toBe(4)
  })

  it('has nothing to land on in an empty edit', () => {
    expect(resolveEditedPosition([], 'a', 1, 1)).toBeNull()
  })
})

describe('nextBoundary', () => {
  // cutBoundariesSec of three 2s scenes.
  const bounds = [0, 2, 4, 6]

  it('finds the boundary on each side of the playhead', () => {
    expect(nextBoundary(bounds, 3, 1)).toBe(4)
    expect(nextBoundary(bounds, 3, -1)).toBe(2)
  })

  it('keeps moving when the playhead sits exactly on a boundary', () => {
    expect(nextBoundary(bounds, 4, 1)).toBe(6)
    expect(nextBoundary(bounds, 4, -1)).toBe(2)
  })

  it('stops at the ends instead of wrapping', () => {
    expect(nextBoundary(bounds, 6, 1)).toBeNull()
    expect(nextBoundary(bounds, 0, -1)).toBeNull()
    expect(nextBoundary([], 1, 1)).toBeNull()
  })
})

describe('followScrollLeft', () => {
  // header 100, viewport 800 wide: on screen between scrollLeft+116 and scrollLeft+752.
  it('leaves the view alone while the playhead is on screen', () => {
    expect(followScrollLeft(400, 0, 800, 100)).toBeNull()
  })

  it('turns a page when the playhead runs off the right', () => {
    expect(followScrollLeft(760, 0, 800, 100)).toBe(644)
  })

  it('turns back when the playhead is left of the view', () => {
    expect(followScrollLeft(300, 1000, 800, 100)).toBe(184)
    expect(followScrollLeft(100, 1000, 800, 100)).toBe(0)
  })
})
