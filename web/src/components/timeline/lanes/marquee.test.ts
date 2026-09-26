import { describe, expect, it } from 'vitest'
import { marqueeHits, marqueeMoved, normalizeBox, shouldStartReorder } from './marquee'

const rects = [
  { id: 'a', left: 0, top: 0, right: 40, bottom: 40 },
  { id: 'b', left: 40, top: 0, right: 100, bottom: 40 },
  { id: 'c', left: 100, top: 0, right: 160, bottom: 40 }
]

describe('marqueeHits', () => {
  it('selects on partial overlap, not containment', () => {
    // Covers the right half of a and the left third of b.
    expect(marqueeHits(rects, { left: 20, top: 10, right: 60, bottom: 30 })).toEqual(['a', 'b'])
  })

  it('selects nothing when the box touches no block', () => {
    expect(marqueeHits(rects, { left: 200, top: 0, right: 240, bottom: 40 })).toEqual([])
    // Touching an edge exactly is not an overlap.
    expect(marqueeHits(rects, { left: 160, top: 0, right: 200, bottom: 40 })).toEqual([])
  })

  it('normalises a box drawn up-and-left (negative extents)', () => {
    expect(marqueeHits(rects, { left: 150, top: 30, right: 50, bottom: 5 })).toEqual(['b', 'c'])
    expect(normalizeBox(10, 20, 5, 2)).toEqual({ left: 5, right: 10, top: 2, bottom: 20 })
  })

  it('ignores a box that misses vertically', () => {
    expect(marqueeHits(rects, { left: 0, top: 50, right: 200, bottom: 80 })).toEqual([])
  })
})

describe('marqueeMoved', () => {
  it('needs 4px in either axis', () => {
    expect(marqueeMoved(3, 0)).toBe(false)
    expect(marqueeMoved(4, 0)).toBe(true)
    expect(marqueeMoved(0, -4)).toBe(true)
  })
})

describe('shouldStartReorder', () => {
  const noHandle = { closest: () => null }
  const onHandle = { closest: (sel: string) => (sel === '[data-trim-handle]' ? {} : null) }

  it('starts on a plain primary press on the block body', () => {
    expect(shouldStartReorder({ altKey: false, button: 0, target: noHandle })).toBe(true)
  })

  it('does not start on Alt (slip) or on a selection modifier', () => {
    expect(shouldStartReorder({ altKey: true, button: 0, target: noHandle })).toBe(false)
    expect(shouldStartReorder({ altKey: false, shiftKey: true, button: 0, target: noHandle })).toBe(
      false
    )
    expect(shouldStartReorder({ altKey: false, metaKey: true, button: 0, target: noHandle })).toBe(
      false
    )
    expect(shouldStartReorder({ altKey: false, ctrlKey: true, button: 0, target: noHandle })).toBe(
      false
    )
  })

  it('does not start from a trim handle, a secondary button or a finger', () => {
    expect(shouldStartReorder({ altKey: false, button: 0, target: onHandle })).toBe(false)
    expect(shouldStartReorder({ altKey: false, button: 2, target: noHandle })).toBe(false)
    expect(
      shouldStartReorder({ altKey: false, button: 0, pointerType: 'touch', target: noHandle })
    ).toBe(false)
  })

  it('tolerates a missing target', () => {
    expect(shouldStartReorder({ altKey: false, button: 0, target: null })).toBe(true)
  })
})
