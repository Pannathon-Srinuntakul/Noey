import { describe, expect, it } from 'vitest'
import { changedCutId } from './sceneDiff'
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
