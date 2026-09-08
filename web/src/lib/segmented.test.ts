import { describe, expect, it } from 'vitest'
import { nextSegmentedIndex } from './segmented'

describe('nextSegmentedIndex', () => {
  it('moves and wraps in both directions', () => {
    expect(nextSegmentedIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextSegmentedIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextSegmentedIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(nextSegmentedIndex('ArrowLeft', 0, 3)).toBe(2)
  })

  it('treats up/down like left/right — the rail is one axis either way', () => {
    expect(nextSegmentedIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextSegmentedIndex('ArrowUp', 0, 3)).toBe(2)
  })

  it('jumps to the ends', () => {
    expect(nextSegmentedIndex('Home', 2, 3)).toBe(0)
    expect(nextSegmentedIndex('End', 0, 3)).toBe(2)
  })

  it('enters from either end when nothing is selected', () => {
    // `duration` is cleared to '' when the music a "ตามความยาวเพลง" pick
    // depended on is removed, so the rail really does render with no
    // selection.
    expect(nextSegmentedIndex('ArrowRight', -1, 3)).toBe(0)
    expect(nextSegmentedIndex('ArrowLeft', -1, 3)).toBe(2)
  })

  it('ignores every other key so typing still reaches the page', () => {
    expect(nextSegmentedIndex('Tab', 0, 3)).toBeNull()
    expect(nextSegmentedIndex('Enter', 0, 3)).toBeNull()
    expect(nextSegmentedIndex('a', 0, 3)).toBeNull()
  })

  it('has nowhere to go in an empty group', () => {
    expect(nextSegmentedIndex('ArrowRight', -1, 0)).toBeNull()
  })
})
