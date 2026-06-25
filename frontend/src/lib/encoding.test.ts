import { describe, expect, it } from 'vitest'
import { engagementColor, gridPosition, sphereRadius } from './encoding'

describe('sphereRadius', () => {
  it('clamps to min for zero/empty', () => {
    expect(sphereRadius(0, 0)).toBeCloseTo(0.35)
    expect(sphereRadius(0, 100)).toBeCloseTo(0.35)
  })
  it('max views gives max radius', () => {
    expect(sphereRadius(100, 100)).toBeCloseTo(1.5)
  })
  it('is monotonic in views', () => {
    expect(sphereRadius(25, 100)).toBeLessThan(sphereRadius(75, 100))
  })
})

describe('engagementColor', () => {
  it('zero rate -> cool blue', () => {
    expect(engagementColor(0)).toBe('#3b82f6')
  })
  it('rate >= 5% -> fully warm amber', () => {
    expect(engagementColor(0.05)).toBe('#f59e0b')
    expect(engagementColor(0.1)).toBe('#f59e0b')
  })
  it('mid rate -> interpolated color', () => {
    const mid = engagementColor(0.025)
    expect(mid).not.toBe('#3b82f6')
    expect(mid).not.toBe('#f59e0b')
  })
})

describe('gridPosition', () => {
  it('is deterministic and centered', () => {
    const p0 = gridPosition(0, 8)
    expect(p0).toEqual(gridPosition(0, 8))
    expect(p0).toHaveLength(3)
  })
})
