import { describe, expect, it } from 'vitest'
import {
  EFFECTS_CATALOG,
  PRESET_GROUPS,
  ZOOM_PRESETS,
  catalogEntry,
  componentTitle,
  inertPropReason,
  instanceTitle,
  presetById,
  presetForInstance
} from './effectsCatalog'
import type { EffectInstance } from './effects'

function inst(componentId: string, props: Record<string, unknown>): EffectInstance {
  return {
    id: 'x',
    kind: 'transform',
    componentId,
    startSec: 1,
    durationSec: 2,
    zOrder: 0,
    props,
    source: 'manual'
  }
}

describe('catalog', () => {
  it('is exactly the three python transforms — no overlay half left', () => {
    expect(EFFECTS_CATALOG.map((c) => c.componentId).sort()).toEqual([
      'punch-zoom',
      'scene-drift',
      'whip-pan'
    ])
  })

  it('exposes zoomFrom on punch-zoom so an open-out is editable by hand', () => {
    const keys = catalogEntry('punch-zoom')!.props.map((p) => p.key)
    expect(keys).toContain('zoomFrom')
    expect(keys).toContain('zoomTo')
  })

  it('componentTitle falls back to the raw id', () => {
    expect(componentTitle('whip-pan')).toBe('ปัดเปลี่ยนฉาก')
    expect(componentTitle('nope')).toBe('nope')
  })
})

describe('presets', () => {
  it('offers six, each built from a real catalog entry', () => {
    expect(ZOOM_PRESETS).toHaveLength(6)
    for (const p of ZOOM_PRESETS) {
      expect(catalogEntry(p.componentId), p.id).toBeDefined()
    }
  })

  it('every preset lands in one of the three picker groups', () => {
    const scopes = new Set(PRESET_GROUPS.map((g) => g.scope))
    for (const p of ZOOM_PRESETS) expect(scopes.has(p.scope), p.id).toBe(true)
  })

  it('open-out really runs backwards and stays held', () => {
    const preset = presetById('open-out')!
    expect(Number(preset.defaults.zoomFrom)).toBeGreaterThan(Number(preset.defaults.zoomTo))
    // A ramp-back at the end would re-tighten the frame and undo the reveal.
    expect(preset.defaults.hold).toBe('true')
  })
})

describe('presetForInstance', () => {
  it('reads the preset back off raw ffmpeg props', () => {
    expect(presetForInstance(inst('whip-pan', {}))?.id).toBe('whip-pan')
    expect(presetForInstance(inst('scene-drift', {}))?.id).toBe('scene-drift')
    expect(presetForInstance(inst('punch-zoom', { cut: 'true', zoomTo: 1.4 }))?.id).toBe('cut-in')
    expect(presetForInstance(inst('punch-zoom', { zoomFrom: 1.6, zoomTo: 1 }))?.id).toBe('open-out')
    expect(
      presetForInstance(inst('punch-zoom', { focusX: 0.4, driftX: 0.7, zoomTo: 1.3 }))?.id
    ).toBe('push-drift')
    expect(presetForInstance(inst('punch-zoom', { zoomTo: 1.3 }))?.id).toBe('push-in')
  })

  it('a cut entry wins over an open-out reading (cut is checked first)', () => {
    expect(
      presetForInstance(inst('punch-zoom', { cut: 'true', zoomFrom: 1.6, zoomTo: 1 }))?.id
    ).toBe('cut-in')
  })

  it('instanceTitle names the preset, not the builder', () => {
    expect(instanceTitle(inst('punch-zoom', { cut: 'true' }))).toBe('ซูมตัดเข้า')
  })
})

describe('inertPropReason', () => {
  it('explains a control instead of hiding it', () => {
    expect(inertPropReason(presetById('cut-in'), 'rampSec')).toBeTruthy()
    expect(inertPropReason(presetById('push-in'), 'rampSec')).toBeNull()
    expect(inertPropReason(presetById('open-out'), 'hold')).toBeTruthy()
    expect(inertPropReason(presetById('push-in'), 'driftX')).toBeTruthy()
    expect(inertPropReason(presetById('push-drift'), 'driftX')).toBeNull()
  })
})
