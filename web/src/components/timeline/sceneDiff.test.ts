import { describe, expect, it } from 'vitest'
import { changedCutId, changedCutIds } from './sceneDiff'
import type { WorkingCut } from './types'

function cut(id: string, inSec: number, outSec: number, source = 'a'): WorkingCut {
  return { id, source, in: inSec, out: outSec, label: id }
}

const base = [cut('c1', 0, 2), cut('c2', 5, 7), cut('c3', 9, 12)]

describe('changedCutId', () => {
  it('finds nothing in an unchanged list', () => {
    expect(
      changedCutId(
        base,
        base.map((c) => ({ ...c }))
      )
    ).toBeNull()
  })

  it('points at a scene that appeared', () => {
    const after = [base[0], cut('new1', 3, 4), base[1], base[2]]
    expect(changedCutId(base, after)).toBe('new1')
  })

  it('points at a retimed scene, and at one that changed footage', () => {
    expect(changedCutId(base, [base[0], cut('c2', 5, 8), base[2]])).toBe('c2')
    expect(changedCutId(base, [base[0], cut('c2', 5, 7, 'b'), base[2]])).toBe('c2')
  })

  it('points at the scene that took a deleted one’s place', () => {
    // c2 gone: c3 slid up into slot 1.
    expect(changedCutId(base, [base[0], base[2]])).toBe('c3')
    // The last scene gone: the one before it is what is there now.
    expect(changedCutId(base, [base[0], base[1]])).toBe('c2')
  })

  it('points at the first slot a reorder changed', () => {
    expect(changedCutId(base, [base[1], base[0], base[2]])).toBe('c2')
  })

  it('survives an empty list on either side', () => {
    expect(changedCutId(base, [])).toBeNull()
    expect(changedCutId([], base)).toBe('c1')
  })
})

describe('changedCutIds', () => {
  it('is empty for an unchanged list', () => {
    expect(
      changedCutIds(
        base,
        base.map((c) => ({ ...c }))
      )
    ).toEqual([])
    expect(changedCutIds(base, [])).toEqual([])
  })

  it('a batch delete of two points at the one scene that slid up', () => {
    expect(changedCutIds(base, [base[2]])).toEqual(['c3'])
    // Both middle scenes gone from a longer list: the scene now in slot 1.
    const longer = [...base, cut('c4', 14, 16)]
    expect(changedCutIds(longer, [longer[0], longer[3]])).toEqual(['c4'])
  })

  it('two retimed scenes are both listed, in play order', () => {
    expect(changedCutIds(base, [cut('c1', 0, 3), base[1], cut('c3', 9, 11)])).toEqual(['c1', 'c3'])
  })

  it('lists every scene a multi-move displaced, but not the tail an insert shifted', () => {
    expect(changedCutIds(base, [base[1], base[2], base[0]])).toEqual(['c2', 'c3', 'c1'])
    // An insert changes every later index without moving anything.
    expect(changedCutIds(base, [base[0], cut('new1', 3, 4), base[1], base[2]])).toEqual(['new1'])
    expect(changedCutIds([], base)).toEqual(['c1', 'c2', 'c3'])
  })

  it('orders added, retimed, slid-into-place, moved, each id once', () => {
    const after = [cut('new1', 3, 4), cut('c3', 9, 13), base[0]] // c2 deleted, c3 retimed and moved
    expect(changedCutIds(base, after)).toEqual(['new1', 'c3', 'c1'])
  })

  it('changedCutId is its first element', () => {
    for (const after of [
      [base[0], base[2]],
      [base[1], base[0], base[2]],
      [base[0], cut('c2', 5, 8), base[2]],
      base,
      []
    ]) {
      expect(changedCutId(base, after)).toBe(changedCutIds(base, after)[0] ?? null)
    }
  })
})
