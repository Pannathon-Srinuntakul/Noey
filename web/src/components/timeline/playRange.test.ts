import { describe, expect, it } from 'vitest'
import type { EditCut } from '../../lib/editorApi'
import type { SnapTarget } from '../../lib/timelineSnap'
import { FRAME_SEC } from './constants'
import { canSkim, playAroundRange, rangeStop, sceneRange, scrubSnapDecision } from './playRange'

const cut = (id: string, source: string, inSec: number, outSec: number): EditCut => ({
  id,
  source,
  in: inSec,
  out: outSec,
  label: ''
})

describe('rangeStop', () => {
  const range = { in: 2, out: 5 }

  it('keeps going inside the range', () => {
    expect(rangeStop(2, range, false)).toBeNull()
    expect(rangeStop(4.9, range, false)).toBeNull()
  })

  it('stops within half a frame of the out-point', () => {
    expect(rangeStop(5 - FRAME_SEC / 2, range, false)).toBe('stop')
    expect(rangeStop(5, range, false)).toBe('stop')
    expect(rangeStop(5.2, range, false)).toBe('stop')
    expect(rangeStop(5 - FRAME_SEC, range, false)).toBeNull()
  })

  it('restarts instead when the loop switch or the range itself loops', () => {
    expect(rangeStop(5, range, true)).toBe('restart')
    expect(rangeStop(5, { ...range, loop: true }, false)).toBe('restart')
    expect(rangeStop(4, { ...range, loop: true }, true)).toBeNull()
  })
})

describe('playAroundRange', () => {
  it('spans pre/post seconds around the moment', () => {
    expect(playAroundRange(10, 30, 1, 1)).toEqual({ in: 9, out: 11 })
    expect(playAroundRange(10, 30, 0.5, 2)).toEqual({ in: 9.5, out: 12 })
  })

  it('clamps at 0 and at the end', () => {
    expect(playAroundRange(0.3, 30, 1, 1)).toEqual({ in: 0, out: 1.3 })
    expect(playAroundRange(29.5, 30, 1, 1)).toEqual({ in: 28.5, out: 30 })
    expect(playAroundRange(0, 30, 1, 1)).toEqual({ in: 0, out: 1 })
    expect(playAroundRange(30, 30, 1, 1)).toEqual({ in: 29, out: 30 })
  })

  it('never inverts on an empty clip', () => {
    const r = playAroundRange(3, 0, 1, 1)
    expect(r.out).toBeGreaterThanOrEqual(r.in)
  })
})

describe('sceneRange', () => {
  const cuts = [cut('a', 'clipA', 10, 12), cut('b', 'clipB', 40, 43.5), cut('c', 'clipA', 0, 1)]
  const editedInById = new Map([
    ['a', 0],
    ['b', 2],
    ['c', 5.5]
  ])

  it('is the edited span in the edited view', () => {
    expect(sceneRange('b', cuts, editedInById, 'edited')).toEqual({
      in: 2,
      out: 5.5,
      source: 'clipB'
    })
  })

  it('is the source window in the source view', () => {
    expect(sceneRange('b', cuts, editedInById, 'source')).toEqual({
      in: 40,
      out: 43.5,
      source: 'clipB'
    })
  })

  it('is null for an unknown scene or one with no segment (skipped)', () => {
    expect(sceneRange('zzz', cuts, editedInById, 'edited')).toBeNull()
    expect(sceneRange('c', cuts, new Map([['a', 0]]), 'edited')).toBeNull()
  })
})

describe('canSkim', () => {
  const idle = {
    playing: false,
    scrubbing: false,
    editing: false,
    swapPending: false,
    enabled: true
  }

  it('skims only over an idle, enabled player', () => {
    expect(canSkim(idle)).toBe(true)
    expect(canSkim({ ...idle, enabled: false })).toBe(false)
    expect(canSkim({ ...idle, playing: true })).toBe(false)
    expect(canSkim({ ...idle, scrubbing: true })).toBe(false)
    expect(canSkim({ ...idle, editing: true })).toBe(false)
    expect(canSkim({ ...idle, swapPending: true })).toBe(false)
  })
})

describe('scrubSnapDecision', () => {
  const targets: SnapTarget[] = [
    { sec: 2, kind: 'cut' },
    { sec: 4, kind: 'voiceover' }
  ]
  const on = { active: true, altKey: false, shiftKey: false }

  it('snaps to the nearest target inside the tolerance', () => {
    const r = scrubSnapDecision(2.1, on, targets, 0.15)
    expect(r.sec).toBe(2)
    expect(r.hit?.target.kind).toBe('cut')
    expect(r.hit?.distSec).toBeCloseTo(0.1)
  })

  it('leaves a candidate outside the tolerance alone', () => {
    expect(scrubSnapDecision(3, on, targets, 0.15)).toEqual({ sec: 3, hit: null })
    // Strict: exactly at the tolerance does not snap.
    expect(scrubSnapDecision(3, on, targets, 1).hit).toBeNull()
    expect(scrubSnapDecision(3, on, targets, 1.01).hit?.target.sec).toBe(2)
  })

  it('bypasses on Alt, on Shift and when the context is inactive', () => {
    expect(scrubSnapDecision(2.1, { ...on, altKey: true }, targets, 0.15)).toEqual({
      sec: 2.1,
      hit: null
    })
    expect(scrubSnapDecision(2.1, { ...on, shiftKey: true }, targets, 0.15)).toEqual({
      sec: 2.1,
      hit: null
    })
    expect(scrubSnapDecision(2.1, { ...on, active: false }, targets, 0.15)).toEqual({
      sec: 2.1,
      hit: null
    })
  })

  it('uses the snapper it is handed', () => {
    const r = scrubSnapDecision(2.1, on, targets, 0.15, (t) => ({ sec: t + 1, hit: null }))
    expect(r.sec).toBeCloseTo(3.1)
    // But not when a modifier bypasses.
    expect(
      scrubSnapDecision(2.1, { ...on, altKey: true }, targets, 0.15, (t) => ({
        sec: t + 1,
        hit: null
      })).sec
    ).toBe(2.1)
  })
})
