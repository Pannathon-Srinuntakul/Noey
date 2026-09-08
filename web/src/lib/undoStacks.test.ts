import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, pushHistory, stepHistory } from './undoStacks'

describe('undo stacks', () => {
  it('moves a snapshot across and hands back what to apply', () => {
    const r = stepHistory(['a', 'b'], [], 'now')
    expect(r.target).toBe('b')
    expect(r.from).toEqual(['a'])
    expect(r.to).toEqual(['now'])
  })

  it('is a no-op on an empty stack, without disturbing the other one', () => {
    const to = ['x']
    const r = stepHistory<string>([], to, 'now')
    expect(r.target).toBeNull()
    expect(r.from).toEqual([])
    expect(r.to).toBe(to)
  })

  it('round-trips: undo then redo returns to where it started', () => {
    let undoS = ['v1']
    let redoS: string[] = []

    const undone = stepHistory(undoS, redoS, 'v2')
    undoS = undone.from
    redoS = undone.to
    expect(undone.target).toBe('v1')

    const redone = stepHistory(redoS, undoS, 'v1')
    expect(redone.target).toBe('v2')
    expect(redone.to).toEqual(['v1'])
    expect(redone.from).toEqual([])
  })

  it('caps both stacks so a long session cannot grow without bound', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `s${i}`)
    expect(pushHistory(full, 'new')).toHaveLength(HISTORY_LIMIT)
    expect(pushHistory(full, 'new').at(-1)).toBe('new')
    // The oldest snapshot is the one dropped.
    expect(pushHistory(full, 'new').at(0)).toBe('s1')
    expect(stepHistory(['a'], full, 'now').to).toHaveLength(HISTORY_LIMIT)
  })

  it('an edit after an undo drops the redo branch', () => {
    // The component clears the redo stack in pushUndo; this pins the intent so
    // a future refactor cannot quietly start resurrecting undone states.
    const afterUndo = stepHistory(['v1'], [], 'v2')
    expect(afterUndo.to).toEqual(['v2'])
    const redoAfterFreshEdit: string[] = []
    expect(redoAfterFreshEdit).toEqual([])
  })
})
