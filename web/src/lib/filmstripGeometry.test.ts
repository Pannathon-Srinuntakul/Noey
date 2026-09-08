import { describe, expect, it } from 'vitest'
import {
  computeCoverRect,
  computeFilmstripSlots,
  computeFilmstripWindow
} from './filmstripGeometry'

describe('computeFilmstripWindow', () => {
  const base = {
    laneLeftPx: 100,
    laneWidthPx: 1000,
    scrollLeft: 0,
    viewportWidth: 800,
    overscanPx: 0
  }

  it('clips the viewport to the lane', () => {
    expect(computeFilmstripWindow(base)).toEqual({
      renderWidth: 1000,
      visibleStartPx: 0,
      visibleEndPx: 700
    })
  })

  it('offsets by scroll', () => {
    const w = computeFilmstripWindow({ ...base, scrollLeft: 400 })
    expect(w).toEqual({ renderWidth: 1000, visibleStartPx: 300, visibleEndPx: 1000 })
  })

  it('grows by the overscan on both sides', () => {
    const w = computeFilmstripWindow({ ...base, scrollLeft: 400, overscanPx: 200 })
    expect(w).toEqual({ renderWidth: 1000, visibleStartPx: 100, visibleEndPx: 1000 })
  })

  it('collapses to an empty range when the lane is off screen', () => {
    const w = computeFilmstripWindow({ ...base, scrollLeft: 5000 })
    expect(w?.visibleStartPx).toBe(1000)
    expect(w?.visibleEndPx).toBe(1000)
  })

  it('rejects nonsense rather than returning a broken window', () => {
    expect(computeFilmstripWindow({ ...base, laneWidthPx: 0 })).toBeNull()
    expect(computeFilmstripWindow({ ...base, viewportWidth: 0 })).toBeNull()
    expect(computeFilmstripWindow({ ...base, scrollLeft: Number.NaN })).toBeNull()
  })
})

describe('computeFilmstripSlots', () => {
  const win = { renderWidth: 1000, visibleStartPx: 0, visibleEndPx: 1000 }
  const base = {
    window: win,
    slotWidthPx: 50,
    sourceStartSec: 0,
    pxPerSec: 40,
    tileSec: 0.5,
    tileCount: 583
  }

  it('lays slots edge to edge across the lane', () => {
    const slots = computeFilmstripSlots(base)
    expect(slots).toHaveLength(20)
    expect(slots[0]).toEqual({ tileIndex: 1, x: 0, width: 50 })
    expect(slots[1]!.x).toBe(50)
  })

  it('samples at the slot centre, not its left edge', () => {
    // Slot 0 spans 0-50px = 0-1.25s of source; its centre is 0.625s, which at
    // 0.5s per tile is tile 1 (0.5-1.0s), not tile 0.
    expect(computeFilmstripSlots(base)[0]!.tileIndex).toBe(1)
  })

  it('offsets by the lane start inside the source', () => {
    const slots = computeFilmstripSlots({ ...base, sourceStartSec: 10 })
    // centre = 10 + 0.625 = 10.625s -> tile 21 (10.5-11.0s)
    expect(slots[0]!.tileIndex).toBe(21)
  })

  it('only builds slots inside the visible window, anchored to the lane', () => {
    const slots = computeFilmstripSlots({
      ...base,
      window: { renderWidth: 1000, visibleStartPx: 220, visibleEndPx: 340 }
    })
    expect(slots[0]!.x).toBe(200) // slot 4 — anchored to the lane, not to 220
    expect(slots.at(-1)!.x).toBe(300)
  })

  it('never indexes past the extracted strip', () => {
    const slots = computeFilmstripSlots({ ...base, tileCount: 3 })
    for (const s of slots) expect(s.tileIndex).toBeLessThanOrEqual(2)
  })

  it('returns nothing rather than dividing by zero', () => {
    expect(computeFilmstripSlots({ ...base, tileSec: 0 })).toEqual([])
    expect(computeFilmstripSlots({ ...base, pxPerSec: 0 })).toEqual([])
    expect(computeFilmstripSlots({ ...base, tileCount: 0 })).toEqual([])
  })
})

describe('computeCoverRect', () => {
  it('crops the long axis, centred', () => {
    // A 9:16 tile into a wider-than-tall slot: scale to the width, overflow
    // above and below in equal measure.
    const r = computeCoverRect(54, 96, 50, 40)
    expect(r.width).toBeCloseTo(50)
    expect(r.height).toBeCloseTo(88.888, 2)
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(-24.444, 2)
  })

  it('is a no-op rect for degenerate input', () => {
    expect(computeCoverRect(0, 96, 50, 40)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
