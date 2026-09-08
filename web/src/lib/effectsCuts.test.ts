import { describe, expect, it } from 'vitest'
import { buildEffectsCutPoints } from './effectsCuts'
import type { LocalProject } from '@renderer/platform/types'

function baseProject(overrides: Partial<LocalProject>): LocalProject {
  return {
    uid: 'p1',
    name: 'test',
    step: 'done',
    createdAt: '',
    updatedAt: '',
    clips: [],
    ...overrides
  } as LocalProject
}

describe('buildEffectsCutPoints', () => {
  it('returns empty array when no edit script/timeline data', () => {
    expect(buildEffectsCutPoints(baseProject({ mode: 'dub_first' }))).toEqual([])
  })

  it('builds internal cut boundaries from a dub_first edit script, dropping the final one', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          { order: 0, sourceIn: 0, sourceOut: 2, durationSec: 2 },
          { order: 1, sourceIn: 2, sourceOut: 5, durationSec: 3 },
          { order: 2, sourceIn: 0, sourceOut: 4, durationSec: 4 }
        ]
      } as unknown as Record<string, unknown>
    })
    // Cumulative: 2, 5, 9 — last (video end) dropped, leaving internal cuts only.
    expect(buildEffectsCutPoints(project)).toEqual([2, 5])
  })

  it('builds internal cut boundaries from a highlight edit script (same shape as dub_first)', () => {
    const project = baseProject({
      mode: 'highlight',
      editScript: {
        segments: [
          { order: 0, sourceIn: 0, sourceOut: 2, durationSec: 2 },
          { order: 1, sourceIn: 2, sourceOut: 5, durationSec: 3 }
        ]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsCutPoints(project)).toEqual([2])
  })

  it('derives durationSec from sourceIn/sourceOut when durationSec is absent', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          { sourceIn: 1, sourceOut: 4 },
          { sourceIn: 0, sourceOut: 3 }
        ]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsCutPoints(project)).toEqual([3])
  })

  it('builds cut boundaries from a talking_head timeline', () => {
    const project = baseProject({
      mode: 'talking_head',
      timeline: {
        timeline: [
          { type: 'clip', source: 'clip0', in: 0, out: 4, label: '' },
          { type: 'clip', source: 'clip1', in: 2, out: 7, label: '' },
          { type: 'clip', source: 'clip0', in: 4, out: 6, label: '' }
        ]
      }
    })
    expect(buildEffectsCutPoints(project)).toEqual([4, 9])
  })

  it('returns empty array for a single-cut clip (no internal boundary)', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [{ sourceIn: 0, sourceOut: 30, durationSec: 30 }]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsCutPoints(project)).toEqual([])
  })

  it('prefers measured clipDurationsSec over nominal edit-script math when present', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          { sourceIn: 0, sourceOut: 2, durationSec: 2 },
          { sourceIn: 2, sourceOut: 5, durationSec: 3 },
          { sourceIn: 0, sourceOut: 4, durationSec: 4 }
        ]
      } as unknown as Record<string, unknown>,
      // Real re-encoded durations differ slightly from the nominal 2/3/4 —
      // the measured values must win, not the edit script's numbers.
      clipDurationsSec: [2.02, 2.98, 4.01]
    })
    expect(buildEffectsCutPoints(project)).toEqual([2.02, 5])
  })

  it('falls back to nominal math when clipDurationsSec length does not match segments', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          { sourceIn: 0, sourceOut: 2, durationSec: 2 },
          { sourceIn: 2, sourceOut: 5, durationSec: 3 }
        ]
      } as unknown as Record<string, unknown>,
      // Stale/mismatched (e.g. from an older render before a re-edit) — ignored.
      clipDurationsSec: [2.02]
    })
    expect(buildEffectsCutPoints(project)).toEqual([2])
  })

  it('drops a boundary too close to zero', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          { sourceIn: 0, sourceOut: 0.01, durationSec: 0.01 },
          { sourceIn: 0, sourceOut: 5, durationSec: 5 }
        ]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsCutPoints(project)).toEqual([])
  })
})
