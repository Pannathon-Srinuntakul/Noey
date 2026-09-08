/** Renderer-side catalog for the camera-motion layer (R8).
 *
 * Two levels, deliberately separate:
 *
 * - CATALOG (`EFFECTS_CATALOG`) — the three ffmpeg transforms the renderer can
 *   actually produce. Mirrors TRANSFORM_REGISTRY in
 *   backend/packages/video/transforms.py, which the renderer cannot import;
 *   keep the prop lists in sync when adding one there.
 * - PRESETS (`ZOOM_PRESETS`) — the six "เอฟเฟกต์การซูม" the user picks from.
 *   These are NOT new builders: three of them are the same `punch-zoom` with
 *   different starting props (hard cut / slow push / open-out / drift). The
 *   split exists because "cut:'true'" is a checkbox to the machine but a
 *   different creative move to a person.
 *
 * The overlay half (a Remotion registry imported through the `@fx` alias) was
 * removed 2026-08-12 — there is no component shelf any more.
 */

import type { EffectInstance } from './effects'

export interface CatalogPropSpec {
  key: string
  type: 'string' | 'number' | 'color' | 'enum'
  label: string
  options?: string[]
  min?: number
  max?: number
}

export interface CatalogEntry {
  componentId: string
  title: string
  props: CatalogPropSpec[]
  /** Sensible starting props when an instance is created without a preset. */
  defaults: Record<string, unknown>
}

const num = (key: string, label: string, min: number, max: number): CatalogPropSpec => ({
  key,
  type: 'number',
  label,
  min,
  max
})

const bool = (key: string, label: string): CatalogPropSpec => ({
  key,
  type: 'enum',
  label,
  options: ['true', 'false']
})

export const EFFECTS_CATALOG: CatalogEntry[] = [
  {
    componentId: 'punch-zoom',
    title: 'ซูมเข้าจุดเดียว',
    props: [
      num('zoomFrom', 'ซูมเริ่ม', 1, 4),
      num('zoomTo', 'ซูมสุด', 1, 4),
      num('focusX', 'จุดโฟกัส X', 0, 1),
      num('focusY', 'จุดโฟกัส Y', 0, 1),
      num('rampSec', 'เวลาซูม (วิ)', 0.05, 5),
      bool('hold', 'ค้างซูมไว้จนจบช่วง'),
      bool('cut', 'ตัดเข้าทันที (ไม่ไล่ระยะ)'),
      num('driftX', 'เลื่อนกล้องไป X', 0, 1),
      num('driftY', 'เลื่อนกล้องไป Y', 0, 1)
    ],
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.3,
      focusX: 0.5,
      focusY: 0.5,
      rampSec: 0.8,
      hold: 'true',
      cut: 'false',
      driftX: 0.5,
      driftY: 0.5
    }
  },
  {
    componentId: 'whip-pan',
    title: 'ปัดเปลี่ยนฉาก',
    props: [
      { key: 'direction', type: 'enum', label: 'ทิศทาง', options: ['horizontal', 'vertical'] },
      num('intensity', 'ความแรง', 0.2, 1)
    ],
    defaults: { direction: 'horizontal', intensity: 0.6 }
  },
  {
    componentId: 'scene-drift',
    title: 'กล้องขยับทั้งฉาก',
    props: [
      num('zoomFrom', 'ซูมเริ่ม', 1, 1.6),
      num('zoomTo', 'ซูมปลาย', 1, 1.6),
      num('focusFromX', 'จุดเริ่ม X', 0, 1),
      num('focusFromY', 'จุดเริ่ม Y', 0, 1),
      num('focusToX', 'จุดปลาย X', 0, 1),
      num('focusToY', 'จุดปลาย Y', 0, 1)
    ],
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.15,
      focusFromX: 0.5,
      focusFromY: 0.5,
      focusToX: 0.5,
      focusToY: 0.5
    }
  }
]

export function catalogEntry(componentId: string): CatalogEntry | undefined {
  return EFFECTS_CATALOG.find((c) => c.componentId === componentId)
}

/** Where a preset can be placed — drives the picker's three groups and whether
 * its timeline block can be dragged/resized at all. */
export type PresetScope = 'span' | 'scene' | 'cut'

export interface ZoomPreset {
  id: string
  title: string
  /** One line: what the effect DOES. Shown in both the picker and the right
   * rail, so it must read correctly before AND after placing — where a preset
   * lands is the picker GROUP's job (see PRESET_GROUPS.note), never this. */
  hint: string
  componentId: string
  scope: PresetScope
  defaults: Record<string, unknown>
}

/** Default seconds for a freshly added span preset (a scene preset spans its
 * whole scene, a cut preset has no length of its own). */
export const PRESET_DEFAULT_SEC = 2.2

export const ZOOM_PRESETS: ZoomPreset[] = [
  {
    id: 'cut-in',
    title: 'ซูมตัดเข้า',
    hint: 'ตัดเข้าใกล้ทันทีในเฟรมเดียว',
    componentId: 'punch-zoom',
    scope: 'span',
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.4,
      focusX: 0.5,
      focusY: 0.5,
      rampSec: 0.06,
      hold: 'true',
      cut: 'true',
      driftX: 0.5,
      driftY: 0.5
    }
  },
  {
    id: 'push-in',
    title: 'ซูมเข้าช้า',
    hint: 'ค่อย ๆ เข้าหาจุดโฟกัส แล้วค้างไว้',
    componentId: 'punch-zoom',
    scope: 'span',
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.3,
      focusX: 0.5,
      focusY: 0.5,
      rampSec: 1.2,
      hold: 'true',
      cut: 'false',
      driftX: 0.5,
      driftY: 0.5
    }
  },
  {
    id: 'open-out',
    title: 'ซูมออกช้า',
    hint: 'เริ่มใกล้แล้วเปิดภาพกว้างออก',
    componentId: 'punch-zoom',
    scope: 'span',
    // zoomFrom > zoomTo runs the same builder backwards (transforms.py ramps
    // either direction). hold MUST stay true: a ramp-back would re-tighten the
    // frame at the end and undo the reveal.
    defaults: {
      zoomFrom: 1.4,
      zoomTo: 1,
      focusX: 0.5,
      focusY: 0.5,
      rampSec: 1.2,
      hold: 'true',
      cut: 'false',
      driftX: 0.5,
      driftY: 0.5
    }
  },
  {
    id: 'push-drift',
    title: 'ซูมแล้วเลื่อนกล้อง',
    hint: 'ซูมเข้าแล้วเลื่อนกล้องต่อระหว่างค้าง',
    componentId: 'punch-zoom',
    scope: 'span',
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.35,
      focusX: 0.4,
      focusY: 0.5,
      rampSec: 1,
      hold: 'true',
      cut: 'false',
      driftX: 0.62,
      driftY: 0.5
    }
  },
  {
    id: 'scene-drift',
    title: 'กล้องขยับทั้งฉาก',
    hint: 'ขยับและซูมเบา ๆ ตลอดฉาก จากเฟรมเริ่มไปเฟรมจบ',
    componentId: 'scene-drift',
    scope: 'scene',
    defaults: {
      zoomFrom: 1,
      zoomTo: 1.15,
      focusFromX: 0.5,
      focusFromY: 0.5,
      focusToX: 0.5,
      focusToY: 0.5
    }
  },
  {
    id: 'whip-pan',
    title: 'ปัดเปลี่ยนฉาก',
    hint: 'ปัดจอตอนเปลี่ยนฉาก ให้รอยต่อดูลื่นขึ้น',
    componentId: 'whip-pan',
    scope: 'cut',
    defaults: { direction: 'horizontal', intensity: 0.6 }
  }
]

/** The picker's three groups. `note` carries WHERE the group's presets land
 * when placement is automatic — said once on the header instead of repeated
 * on every row under it. */
export const PRESET_GROUPS: { label: string; scope: PresetScope; note?: string }[] = [
  { label: 'ใส่เฉพาะบางช่วงของฉาก', scope: 'span', note: 'เริ่มที่หัวเล่น' },
  { label: 'ใส่ทั้งฉาก', scope: 'scene', note: 'ฉากที่หัวเล่นอยู่' },
  { label: 'ใส่ที่รอยต่อฉาก', scope: 'cut', note: 'รอยต่อที่ใกล้หัวเล่นที่สุด' }
]

export function presetById(id: string): ZoomPreset | undefined {
  return ZOOM_PRESETS.find((p) => p.id === id)
}

function asNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Which of the six an existing instance IS. Nothing is stored on the instance
 * to say so — effects.json holds raw ffmpeg props and the AI writes it too, so
 * the preset has to be read back off those props. Order matters: open-out and
 * cut-in are checked before the plain push they would otherwise look like.
 */
export function presetForInstance(inst: EffectInstance): ZoomPreset | undefined {
  if (inst.componentId === 'whip-pan') return presetById('whip-pan')
  if (inst.componentId === 'scene-drift') return presetById('scene-drift')
  if (inst.componentId !== 'punch-zoom') return undefined

  const p = inst.props
  if (String(p.cut) === 'true') return presetById('cut-in')

  const from = asNum(p.zoomFrom, 1)
  const to = asNum(p.zoomTo, 1.3)
  if (from > to + 1e-6) return presetById('open-out')

  const fx = asNum(p.focusX, 0.5)
  const fy = asNum(p.focusY, 0.5)
  const dx = asNum(p.driftX, fx)
  const dy = asNum(p.driftY, fy)
  if (Math.abs(dx - fx) > 0.01 || Math.abs(dy - fy) > 0.01) return presetById('push-drift')

  return presetById('push-in')
}

/** Human title for one instance — the preset's name, not the raw builder id. */
export function instanceTitle(inst: EffectInstance): string {
  return presetForInstance(inst)?.title ?? catalogEntry(inst.componentId)?.title ?? inst.componentId
}

/** Human title for a componentId alone (no instance in hand). */
export function componentTitle(componentId: string): string {
  return catalogEntry(componentId)?.title ?? componentId
}

/** Prop keys that are meaningless for this preset — the right rail shows them
 * muted with a reason instead of hiding them (a control that disappears reads
 * as a bug; one that explains itself reads as a rule). */
export function inertPropReason(preset: ZoomPreset | undefined, key: string): string | null {
  if (!preset) return null
  if (preset.id === 'cut-in' && key === 'rampSec') {
    return 'ซูมแบบนี้เข้าในเฟรมเดียว จึงไม่มีเวลาซูมให้ตั้ง'
  }
  if (preset.id === 'cut-in' && key === 'zoomFrom') {
    return 'ตัดเข้าทันที ไม่ได้เริ่มจากระยะไหน'
  }
  if (preset.id === 'open-out' && key === 'hold') {
    return 'ซูมออกต้องค้างไว้จนจบ ไม่งั้นภาพจะกลับไปใกล้อีกครั้ง'
  }
  if (preset.id !== 'push-drift' && (key === 'driftX' || key === 'driftY')) {
    return 'ใช้เฉพาะแบบซูมแล้วเลื่อนกล้อง'
  }
  return null
}
