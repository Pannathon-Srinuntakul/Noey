import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  clearSelection,
  idsBetween,
  idsInOrder,
  keyBurstIsNewStep,
  primaryOf,
  pruneSelection,
  selectAll,
  selectClick,
  selectForward,
  selectMarquee,
  selectOnly,
  type SelectionState
} from './selection'

const order = ['a', 'b', 'c', 'd', 'e', 'f']
const plain = { shift: false, toggle: false }
const toggle = { shift: false, toggle: true }
const shift = { shift: true, toggle: false }

describe('selectClick', () => {
  it('a plain click selects that scene alone and anchors there', () => {
    const s = selectClick(selectAll(order), 'c', plain, order)
    expect(s).toEqual({ ids: ['c'], anchor: 'c', primary: 'c' })
    expect(primaryOf(s)).toBe('c')
  })

  it('a toggle click adds, then removes, and the primary follows', () => {
    let s = selectClick(EMPTY_SELECTION, 'b', plain, order)
    s = selectClick(s, 'd', toggle, order)
    expect(s).toEqual({ ids: ['b', 'd'], anchor: 'd', primary: 'd' })
    s = selectClick(s, 'd', toggle, order)
    expect(s).toEqual({ ids: ['b'], anchor: 'b', primary: 'b' })
    s = selectClick(s, 'b', toggle, order)
    expect(s).toEqual(EMPTY_SELECTION)
  })

  it('removing a toggled scene that was not the anchor keeps the anchor', () => {
    let s = selectClick(EMPTY_SELECTION, 'b', plain, order)
    s = selectClick(s, 'd', toggle, order)
    s = selectClick(s, 'e', toggle, order)
    s = selectClick(s, 'd', toggle, order)
    expect(s).toEqual({ ids: ['b', 'e'], anchor: 'e', primary: 'e' })
  })

  it('a shift click takes the range from the anchor, either way round', () => {
    let s = selectClick(EMPTY_SELECTION, 'c', plain, order)
    s = selectClick(s, 'e', shift, order)
    expect(s).toEqual({ ids: ['c', 'd', 'e'], anchor: 'c', primary: 'e' })
    s = selectClick(s, 'a', shift, order)
    expect(s).toEqual({ ids: ['a', 'b', 'c'], anchor: 'c', primary: 'a' })
  })

  it('a second shift click shrinks the range instead of growing it', () => {
    let s = selectClick(EMPTY_SELECTION, 'b', plain, order)
    s = selectClick(s, 'f', shift, order)
    s = selectClick(s, 'c', shift, order)
    expect(s.ids).toEqual(['b', 'c'])
    expect(s.anchor).toBe('b')
  })

  it('a shift range across a toggle keeps the toggled scene and extends from the toggle', () => {
    let s = selectClick(EMPTY_SELECTION, 'a', plain, order)
    s = selectClick(s, 'c', toggle, order)
    s = selectClick(s, 'e', shift, order)
    expect(s.ids).toEqual(['a', 'c', 'd', 'e'])
    expect(s.anchor).toBe('c')
    expect(s.primary).toBe('e')
    // Shrinking that range keeps `a` too.
    s = selectClick(s, 'd', shift, order)
    expect(s.ids).toEqual(['a', 'c', 'd'])
  })

  it('a shift click with nothing selected selects just that scene', () => {
    expect(selectClick(EMPTY_SELECTION, 'd', shift, order)).toEqual({
      ids: ['d'],
      anchor: 'd',
      primary: 'd'
    })
  })
})

describe('marquee, all, forward', () => {
  it('a non-additive marquee is the hits; an additive one unions them', () => {
    const s = selectMarquee(selectOnly('a'), ['c', 'd'], false)
    expect(s).toEqual({ ids: ['c', 'd'], anchor: 'c', primary: 'd' })
    const t = selectMarquee(selectOnly('a'), ['c', 'd'], true)
    expect(t).toEqual({ ids: ['a', 'c', 'd'], anchor: 'a', primary: 'd' })
    expect(selectMarquee(selectOnly('a'), [], true)).toEqual(selectOnly('a'))
    expect(selectMarquee(selectOnly('a'), [], false)).toEqual(EMPTY_SELECTION)
  })

  it('selectAll takes the whole order; clearSelection empties it', () => {
    expect(selectAll(order).ids).toEqual(order)
    expect(selectAll([])).toEqual(EMPTY_SELECTION)
    expect(clearSelection()).toEqual(EMPTY_SELECTION)
  })

  it('selectForward takes the scene and everything after it', () => {
    expect(selectForward(order, 'd')).toEqual({ ids: ['d', 'e', 'f'], anchor: 'd', primary: 'd' })
    expect(selectForward(order, 'zz')).toEqual(selectOnly('zz'))
  })
})

describe('pruneSelection', () => {
  it('drops ids that no longer exist and moves the primary to the last survivor', () => {
    const s: SelectionState = { ids: ['b', 'c', 'd'], anchor: 'b', primary: 'd' }
    const pruned = pruneSelection(s, new Set(['a', 'b', 'c']))
    expect(pruned).toEqual({ ids: ['b', 'c'], anchor: 'b', primary: 'c' })
  })

  it('an anchor that vanished follows the primary', () => {
    const s: SelectionState = { ids: ['b', 'c'], anchor: 'b', primary: 'c' }
    expect(pruneSelection(s, ['c'])).toEqual({ ids: ['c'], anchor: 'c', primary: 'c' })
  })

  it('returns the same object when nothing was lost', () => {
    const s: SelectionState = { ids: ['b'], anchor: 'b', primary: 'b' }
    expect(pruneSelection(s, ['a', 'b'])).toBe(s)
    expect(pruneSelection(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION)
  })

  it('empties when everything selected was deleted', () => {
    expect(pruneSelection(selectOnly('b'), ['a'])).toEqual(EMPTY_SELECTION)
  })
})

describe('helpers', () => {
  it('idsBetween is inclusive and order-independent', () => {
    expect(idsBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(idsBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(idsBetween(order, 'c', 'c')).toEqual(['c'])
    expect(idsBetween(order, 'zz', 'c')).toEqual(['c'])
    expect(idsBetween(order, 'zz', 'yy')).toEqual([])
  })

  it('idsInOrder lays picked ids out along the sequence', () => {
    expect(idsInOrder(['e', 'a', 'c'], order)).toEqual(['a', 'c', 'e'])
  })

  it('keyBurstIsNewStep: the first press and a press after the gap start a step', () => {
    expect(keyBurstIsNewStep(0, 1000, 400)).toBe(true)
    expect(keyBurstIsNewStep(1000, 1200, 400)).toBe(false)
    expect(keyBurstIsNewStep(1000, 1400, 400)).toBe(false)
    expect(keyBurstIsNewStep(1000, 1401, 400)).toBe(true)
  })
})
