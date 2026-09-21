import { describe, expect, it } from 'vitest'
import { edgeZonePx } from './constants'

describe('edgeZonePx', () => {
  it('is 8px on a normal block', () => {
    expect(edgeZonePx(120)).toBe(8)
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
})
