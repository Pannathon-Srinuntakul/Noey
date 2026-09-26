import { describe, expect, it } from 'vitest'
import { even, quantiseToFrames } from './util'

describe('even', () => {
  it('rounds an odd dimension down, never up', () => {
    expect(even(1081)).toBe(1080)
    expect(even(1080)).toBe(1080)
    expect(even(1)).toBe(0)
  })
})

describe('quantiseToFrames', () => {
  it('rounds to whole frames at the given rate', () => {
    expect(quantiseToFrames(1, 30)).toBe(1)
    expect(quantiseToFrames(0.51, 30)).toBeCloseTo(15 / 30, 10)
    expect(quantiseToFrames(0.5166, 30)).toBeCloseTo(15 / 30, 10)
    expect(quantiseToFrames(0.5167, 30)).toBeCloseTo(16 / 30, 10)
  })

  it('is never shorter than one frame', () => {
    expect(quantiseToFrames(0, 30)).toBeCloseTo(1 / 30, 10)
    expect(quantiseToFrames(0.001, 30)).toBeCloseTo(1 / 30, 10)
  })

  it('sums the way the render does — per cut, not on the total', () => {
    // Three cuts of 0.35 s: each rounds to 11 frames (0.3667 s), so the
    // picture is 33 frames long — 1.1 s, not the 1.05 s the raw sum says.
    const cuts = [0.35, 0.35, 0.35]
    const total = cuts.reduce((n, c) => n + quantiseToFrames(c, 30), 0)
    expect(Math.round(total * 30)).toBe(33)
  })
})
