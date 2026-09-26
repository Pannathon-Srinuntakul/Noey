import { describe, expect, it } from 'vitest'
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './constants'
import {
  anchoredScrollLeft,
  autoScrollStep,
  centreTime,
  centredScrollLeft,
  edgeHint,
  fitPxPerSec,
  flashKeyframes,
  leadPxFor,
  pinchFactor,
  rangeZoom,
  timeFromScroll
} from './viewportMath'

const HEADER = 92

describe('anchoredScrollLeft', () => {
  it('keeps the anchor time under the pointer after a zoom', () => {
    const anchor = 12.5
    const next = 80
    const pointerVX = 300
    const scrollLeft = anchoredScrollLeft(anchor, next, pointerVX, HEADER)
    expect(HEADER + anchor * next - pointerVX).toBe(scrollLeft)
    // The anchor's viewport x after the zoom is the pointer's.
    expect(HEADER + anchor * next - scrollLeft).toBe(pointerVX)
  })

  it('never scrolls before the start', () => {
    expect(anchoredScrollLeft(0.5, 10, 500, HEADER)).toBe(0)
  })

  it('shifts by the touch lead so the padded axis anchors too', () => {
    expect(anchoredScrollLeft(2, 40, 100, HEADER, 200)).toBe(HEADER + 200 + 80 - 100)
  })
})

describe('fitPxPerSec', () => {
  it('fills the drawable width minus the tail', () => {
    // 1000 − 92 − 160 = 748 px for 10 s.
    expect(fitPxPerSec(1000, 10, HEADER, 160)).toBeCloseTo(74.8)
  })

  it('clamps to the zoom range', () => {
    expect(fitPxPerSec(1000, 1, HEADER, 160)).toBe(MAX_PX_PER_SEC)
    expect(fitPxPerSec(1000, 10_000, HEADER, 160)).toBe(MIN_PX_PER_SEC)
  })

  it('does not zoom to nothing on a tiny viewport or an empty clip', () => {
    expect(fitPxPerSec(100, 10, HEADER, 160)).toBeCloseTo(12)
    expect(fitPxPerSec(1000, 0, HEADER, 160)).toBe(MIN_PX_PER_SEC)
  })
})

describe('rangeZoom', () => {
  it('fills the width between the pads and starts the range at the left pad', () => {
    const r = rangeZoom(10, 14, 1000, HEADER, 24)
    // (1000 − 92 − 48) / 4 = 215 → clamped to the max.
    expect(r.pxPerSec).toBe(MAX_PX_PER_SEC)
    expect(r.scrollLeft).toBe(10 * MAX_PX_PER_SEC - 24)
  })

  it('lands the in-point exactly at the pad when unclamped', () => {
    const r = rangeZoom(3, 13, 1000, HEADER, 24)
    expect(r.pxPerSec).toBeCloseTo(86)
    // viewport x of inSec = HEADER + in·px − scrollLeft = HEADER + pad
    expect(HEADER + 3 * r.pxPerSec - r.scrollLeft).toBeCloseTo(HEADER + 24)
  })

  it('clamps a long range to the minimum zoom and a short one to the maximum', () => {
    expect(rangeZoom(0, 1000, 1000, HEADER, 24).pxPerSec).toBe(MIN_PX_PER_SEC)
    expect(rangeZoom(0, 0.1, 1000, HEADER, 24).pxPerSec).toBe(MAX_PX_PER_SEC)
    expect(rangeZoom(0, 0.1, 1000, HEADER, 24).scrollLeft).toBe(0)
  })

  it('survives a zero-length range', () => {
    const r = rangeZoom(5, 5, 1000, HEADER, 24)
    expect(Number.isFinite(r.pxPerSec)).toBe(true)
    expect(r.pxPerSec).toBe(MAX_PX_PER_SEC)
  })
})

describe('pinchFactor', () => {
  it('is the ratio of the finger distances', () => {
    expect(pinchFactor(100, 150)).toBe(1.5)
    expect(pinchFactor(200, 100)).toBe(0.5)
  })

  it('zooms by nothing from a degenerate start', () => {
    expect(pinchFactor(0, 100)).toBe(1)
    expect(pinchFactor(100, NaN)).toBe(1)
  })
})

describe('centreTime', () => {
  it('is the time under the middle of the drawable area', () => {
    // Drawable = 1000 − 92 = 908 → centre at viewport x 92 + 454 = 546;
    // content x = 546 + 400 = 946; t = (946 − 92) / 40.
    expect(centreTime(400, 1000, 40, HEADER)).toBeCloseTo(854 / 40)
  })

  it('subtracts the touch lead', () => {
    expect(centreTime(0, 1000, 40, HEADER, 454)).toBeCloseTo(0)
  })
})

describe('autoScrollStep', () => {
  const L = 100
  const R = 900
  const EDGE = 40
  const MAX = 24

  it('is ±max at the very edge', () => {
    expect(autoScrollStep(L, L, R, EDGE, MAX)).toBe(-MAX)
    expect(autoScrollStep(R, L, R, EDGE, MAX)).toBe(MAX)
  })

  it('keeps going at max past the edge (a drag that left the panel)', () => {
    expect(autoScrollStep(L - 300, L, R, EDGE, MAX)).toBe(-MAX)
    expect(autoScrollStep(R + 300, L, R, EDGE, MAX)).toBe(MAX)
  })

  it('is 0 at the inner edge of the band and outside it', () => {
    expect(autoScrollStep(L + EDGE, L, R, EDGE, MAX)).toBe(0)
    expect(autoScrollStep(R - EDGE, L, R, EDGE, MAX)).toBe(0)
    expect(autoScrollStep(500, L, R, EDGE, MAX)).toBe(0)
  })

  it('ramps quadratically in between', () => {
    // Halfway into the band → a quarter of max.
    expect(autoScrollStep(R - EDGE / 2, L, R, EDGE, MAX)).toBeCloseTo(MAX / 4)
    expect(autoScrollStep(L + EDGE / 2, L, R, EDGE, MAX)).toBeCloseTo(-MAX / 4)
    // Three quarters in → 9/16.
    expect(autoScrollStep(R - EDGE / 4, L, R, EDGE, MAX)).toBeCloseTo((MAX * 9) / 16)
  })

  it('is 0 once the panel is already at that scroll bound', () => {
    expect(autoScrollStep(L, L, R, EDGE, MAX, 0, 2000)).toBe(0)
    expect(autoScrollStep(R, L, R, EDGE, MAX, 2000, 2000)).toBe(0)
    expect(autoScrollStep(L, L, R, EDGE, MAX, 10, 2000)).toBe(-MAX)
    expect(autoScrollStep(R, L, R, EDGE, MAX, 1990, 2000)).toBe(MAX)
  })
})

describe('edgeHint', () => {
  it('matches followScrollLeft: on screen between the margins', () => {
    expect(edgeHint(HEADER + 16, 0, 1000, HEADER)).toBeNull()
    expect(edgeHint(1000 - 48, 0, 1000, HEADER)).toBeNull()
  })

  it('names the side the playhead ran off', () => {
    expect(edgeHint(HEADER + 15, 0, 1000, HEADER)).toBe('left')
    expect(edgeHint(1000 - 47, 0, 1000, HEADER)).toBe('right')
    // Scrolled: a playhead under the label column is off to the left.
    expect(edgeHint(500, 450, 1000, HEADER)).toBe('left')
  })
})

describe('touch-scrub model', () => {
  it('centredScrollLeft and timeFromScroll invert each other', () => {
    expect(centredScrollLeft(3.5, 40)).toBe(140)
    expect(timeFromScroll(140, 40)).toBe(3.5)
    expect(timeFromScroll(centredScrollLeft(7.25, 60), 60)).toBeCloseTo(7.25)
  })

  it('never goes before the start', () => {
    expect(centredScrollLeft(-1, 40)).toBe(0)
    expect(timeFromScroll(-10, 40)).toBe(0)
  })

  it('leads by half the viewport minus the label column, only in touch mode', () => {
    expect(leadPxFor(390, HEADER, true)).toBe(195 - HEADER)
    expect(leadPxFor(390, HEADER, false)).toBe(0)
    expect(leadPxFor(100, HEADER, true)).toBe(0)
  })
})

describe('flashKeyframes', () => {
  it('is empty under reduced motion and a ring otherwise', () => {
    expect(flashKeyframes(true)).toEqual([])
    expect(flashKeyframes(false).length).toBe(3)
  })
})
