import { describe, expect, it } from 'vitest'
import {
  MENU_MARGIN_PX,
  MENU_W_PX,
  clampMenuPosition,
  nextMenuIndex,
  parseFramesForm
} from './contextMenu'

describe('chrome helpers', () => {
  describe('clampMenuPosition', () => {
    const W = MENU_W_PX
    const H = 300
    const VW = 1280
    const VH = 800

    it('opens at the pointer when there is room', () => {
      expect(clampMenuPosition(400, 300, W, H, VW, VH)).toEqual({ left: 400, top: 300 })
    })

    it('flips to the left of the pointer near the right edge', () => {
      const r = clampMenuPosition(VW - 50, 300, W, H, VW, VH)
      expect(r.left).toBe(VW - 50 - W)
      expect(r.top).toBe(300)
    })

    it('flips above the pointer near the bottom edge', () => {
      const r = clampMenuPosition(400, VH - 40, W, H, VW, VH)
      expect(r.top).toBe(VH - 40 - H)
      expect(r.left).toBe(400)
    })

    it('flips both ways in the bottom-right corner', () => {
      const r = clampMenuPosition(VW - 10, VH - 10, W, H, VW, VH)
      expect(r.left + W).toBeLessThanOrEqual(VW)
      expect(r.top + H).toBeLessThanOrEqual(VH)
    })

    it('never leaves the viewport at the top-left, and clamps a panel taller than it', () => {
      const r = clampMenuPosition(2, 3, W, H, VW, VH)
      expect(r.left).toBeGreaterThanOrEqual(0)
      expect(r.top).toBeGreaterThanOrEqual(0)
      const tall = clampMenuPosition(400, 500, W, 2000, VW, VH)
      expect(tall.top).toBe(MENU_MARGIN_PX)
      const narrow = clampMenuPosition(100, 100, W, H, 150, VH)
      expect(narrow.left).toBe(MENU_MARGIN_PX)
    })
  })

  describe('parseFramesForm', () => {
    it('reads m:ss:ff at 30 fps', () => {
      expect(parseFramesForm('0:07:12')).toBeCloseTo(7 + 12 / 30, 6)
      expect(parseFramesForm('1:02:00')).toBe(62)
      expect(parseFramesForm(' 0:00:29 ')).toBeCloseTo(29 / 30, 6)
    })

    it('reads h:mm:ss:ff too', () => {
      expect(parseFramesForm('1:02:03:15')).toBeCloseTo(3723.5, 6)
    })

    it('leaves other forms to the plain parser', () => {
      expect(parseFramesForm('0:07:30')).toBeNull() // 30 is not a frame at 30 fps
      expect(parseFramesForm('0:07:3')).toBeNull() // one digit → h:mm:ss territory
      expect(parseFramesForm('0:07.5')).toBeNull()
      expect(parseFramesForm('0:07:12.5')).toBeNull()
      expect(parseFramesForm('12')).toBeNull()
      expect(parseFramesForm('')).toBeNull()
    })

    it('honours another fps', () => {
      expect(parseFramesForm('0:01:24', 25)).toBeCloseTo(1 + 24 / 25, 6)
      expect(parseFramesForm('0:01:25', 25)).toBeNull()
    })
  })

  describe('nextMenuIndex', () => {
    it('wraps and enters from nothing focused', () => {
      expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0)
      expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2)
      expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0)
      expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2)
      expect(nextMenuIndex('Home', 2, 3)).toBe(0)
      expect(nextMenuIndex('End', 0, 3)).toBe(2)
      expect(nextMenuIndex('Enter', 0, 3)).toBeNull()
      expect(nextMenuIndex('ArrowDown', 0, 0)).toBeNull()
    })
  })
})
