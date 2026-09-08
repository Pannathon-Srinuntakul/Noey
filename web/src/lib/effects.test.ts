import { describe, expect, it } from 'vitest'
import {
  EFFECTS_DOC_VERSION,
  effectEndSec,
  emptyEffectsDoc,
  normalizeEffectsDoc,
  legacyOverlayInstances,
  transformInstances,
  type EffectsDoc
} from './effects'

describe('emptyEffectsDoc', () => {
  it('is versioned and effect-free', () => {
    const doc = emptyEffectsDoc()
    expect(doc.version).toBe(EFFECTS_DOC_VERSION)
    expect(doc.instances).toEqual([])
  })
})

describe('normalizeEffectsDoc', () => {
  it('returns empty for non-object input', () => {
    expect(normalizeEffectsDoc(null).instances).toEqual([])
    expect(normalizeEffectsDoc(undefined).instances).toEqual([])
    expect(normalizeEffectsDoc('nope').instances).toEqual([])
    expect(normalizeEffectsDoc({}).instances).toEqual([])
  })

  it('sorts by start then zOrder', () => {
    const doc = normalizeEffectsDoc({
      instances: [
        { kind: 'overlay', componentId: 'b', startSec: 5, durationSec: 1, zOrder: 0 },
        { kind: 'overlay', componentId: 'a', startSec: 1, durationSec: 1, zOrder: 2 },
        { kind: 'overlay', componentId: 'c', startSec: 1, durationSec: 1, zOrder: 1 }
      ]
    })
    expect(doc.instances.map((i) => i.componentId)).toEqual(['c', 'a', 'b'])
  })

  it('drops bad instances, keeps valid ones', () => {
    const doc = normalizeEffectsDoc({
      instances: [
        { kind: 'overlay', componentId: 'ok', startSec: 0, durationSec: 1 },
        { kind: 'not-a-kind', componentId: 'bad', startSec: 0, durationSec: 1 },
        'not-an-object',
        { componentId: 'missing-kind', startSec: 0, durationSec: 1 },
        { kind: 'transform', componentId: 'no-nums', startSec: 'x', durationSec: 1 }
      ]
    })
    expect(doc.instances.map((i) => i.componentId)).toEqual(['ok'])
  })

  it('clamps start/duration and defaults optional fields', () => {
    const doc = normalizeEffectsDoc({
      instances: [{ kind: 'transform', componentId: 'punch-zoom', startSec: -3, durationSec: 0 }]
    })
    const inst = doc.instances[0]
    expect(inst.startSec).toBe(0)
    expect(inst.durationSec).toBe(0.01)
    expect(inst.zOrder).toBe(0)
    expect(inst.source).toBe('ai')
    expect(inst.props).toEqual({})
    expect(inst.id).toMatch(/^eff_/)
  })

  it('preserves valid provenance and props', () => {
    const doc = normalizeEffectsDoc({
      instances: [
        {
          id: 'eff_keep',
          kind: 'overlay',
          componentId: 'sticker',
          startSec: 2,
          durationSec: 1,
          zOrder: 3,
          props: { color: '#FFD400' },
          source: 'manual'
        }
      ]
    })
    expect(doc.instances[0]).toMatchObject({
      id: 'eff_keep',
      source: 'manual',
      zOrder: 3,
      props: { color: '#FFD400' }
    })
  })
})

describe('partition helpers', () => {
  const doc: EffectsDoc = {
    version: 1,
    instances: [
      {
        id: 'a',
        kind: 'overlay',
        componentId: 'popup',
        startSec: 0,
        durationSec: 1,
        zOrder: 0,
        props: {},
        source: 'ai'
      },
      {
        id: 'b',
        kind: 'transform',
        componentId: 'punch-zoom',
        startSec: 1,
        durationSec: 2,
        zOrder: 0,
        props: {},
        source: 'ai'
      }
    ]
  }

  it('separates live transforms from leftover overlay instances', () => {
    // An old effects.json still parses — the editor lists these read-only so
    // the user can delete them rather than the page breaking on load.
    expect(legacyOverlayInstances(doc).map((i) => i.componentId)).toEqual(['popup'])
    expect(transformInstances(doc).map((i) => i.componentId)).toEqual(['punch-zoom'])
  })

  it('computes end time', () => {
    expect(effectEndSec(doc.instances[1])).toBe(3)
  })
})
