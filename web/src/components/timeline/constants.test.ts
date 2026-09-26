import { describe, expect, it } from 'vitest'
import {
  COARSE_EDGE_ZONE_PX,
  FRAME_SEC,
  SCRUB_SNAP_THRESHOLD_PX,
  SNAP_THRESHOLD_PX,
  edgeZonePx
} from './constants'

describe('edgeZonePx', () => {
  it('is 8px on a normal block', () => {
    expect(edgeZonePx(120)).toBe(8)
    expect(edgeZonePx(100)).toBe(8)
    expect(edgeZonePx(24)).toBe(8)
  })

  it('narrows on a narrow block so every block trims and keeps a middle', () => {
    expect(edgeZonePx(12)).toBe(4)
    expect(edgeZonePx(3)).toBe(1)
    expect(2 * edgeZonePx(9)).toBeLessThan(9)
  })

  it('is zero on an empty block', () => {
    expect(edgeZonePx(0)).toBe(0)
  })

  it('widens to the touch target on a coarse pointer, still keeping a middle third', () => {
    expect(edgeZonePx(100, true)).toBe(COARSE_EDGE_ZONE_PX)
    expect(edgeZonePx(100, true)).toBe(22)
    expect(edgeZonePx(30, true)).toBe(10)
    expect(edgeZonePx(0, true)).toBe(0)
  })
})

describe('interaction constants', () => {
  it('one frame is 1/30 s', () => {
    expect(FRAME_SEC * 30).toBe(1)
  })

  it('scrub snap is softer than trim snap', () => {
    expect(SCRUB_SNAP_THRESHOLD_PX).toBeLessThan(SNAP_THRESHOLD_PX)
  })
})
