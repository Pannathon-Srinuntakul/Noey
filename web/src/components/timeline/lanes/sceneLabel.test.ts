import { describe, expect, it } from 'vitest'
import type { EditCut } from '../../../lib/editorApi'
import { MIN_CUT_SEC, fmtSignedSec } from '../../../lib/timelineMath'
import type { SnapTarget } from '../../../lib/timelineSnap'
import {
  musicReadoutText,
  pickMusicSnap,
  quantizeDeltaToFrame,
  reorderHint,
  rollReadoutText,
  sceneNoteOf,
  sceneTitleLine,
  sceneTooltip,
  slipReadoutText,
  stripTileFor,
  trimFrame,
  trimReadoutText
} from './sceneLabel'

const cut: EditCut = { id: 'cut1', source: 'B', in: 1, out: 3, label: '' }

describe('readout text', () => {
  it('trim: signed seconds, frames and the new length', () => {
    expect(trimReadoutText({ deltaSec: 0.4, durationSec: 2.1, atLimit: false })).toBe(
      '+0.40 วิ (+12 เฟรม) · ยาว 2.10 วิ'
    )
  })

  it('trim at the footage end appends หมดฟุตเทจ', () => {
    expect(trimReadoutText({ deltaSec: 0.4, durationSec: 2.1, atLimit: true })).toBe(
      '+0.40 วิ (+12 เฟรม) · ยาว 2.10 วิ · หมดฟุตเทจ'
    )
  })

  it('slip / roll / music variants', () => {
    expect(slipReadoutText(0.4)).toBe('เลื่อนหน้าต่าง +0.40 วิ')
    expect(rollReadoutText(0.4)).toBe('เลื่อนรอยตัด +0.40 วิ')
    expect(slipReadoutText(-0.07)).toBe(`เลื่อนหน้าต่าง ${fmtSignedSec(-0.07)}`)
    expect(musicReadoutText(3.2)).toBe('เริ่มที่ 0:03.2')
  })
})

describe('sceneTooltip', () => {
  const base = { playOrder: 3, editedIn: 12, durationSec: 3.2, sourceLabel: 'B', sourceIn: 41 }

  it('formats the title line', () => {
    expect(sceneTitleLine(base)).toBe('ฉาก 3 · 0:12.0–0:15.2 · จากคลิป B ที่ 0:41.0')
  })

  it('adds the AI note on a second line when present, nothing otherwise', () => {
    expect(sceneTooltip({ ...base, note: 'มุมกว้างเห็นสินค้าชัด' })).toBe(
      'ฉาก 3 · 0:12.0–0:15.2 · จากคลิป B ที่ 0:41.0\nมุมกว้างเห็นสินค้าชัด'
    )
    expect(sceneTooltip({ ...base, note: '  ' })).toBe(sceneTitleLine(base))
    expect(sceneTooltip(base)).toBe(sceneTitleLine(base))
  })

  it('names the source neutrally when the clip label is unknown', () => {
    expect(sceneTitleLine({ ...base, sourceLabel: undefined })).toBe(
      'ฉาก 3 · 0:12.0–0:15.2 · ต้นฉบับที่ 0:41.0'
    )
  })

  it('reads the note from an alternate first, then the visual description', () => {
    expect(
      sceneNoteOf({ meta: { alternates: [{ note: 'ช็อตสำรอง' }], visualDescription: 'x' } })
    ).toBe('ช็อตสำรอง')
    expect(sceneNoteOf({ meta: { alternates: [], visualDescription: 'เห็นหน้า' } })).toBe(
      'เห็นหน้า'
    )
    expect(sceneNoteOf({ meta: undefined })).toBeNull()
    expect(sceneNoteOf({ meta: { alternates: [{}] } })).toBeNull()
  })
})

describe('reorderHint', () => {
  it('names the block the scene lands before', () => {
    // Dragged backward: lands before the block it is over.
    expect(reorderHint(0, 5, 3)).toBe('ก่อนฉาก 1')
    // Dragged forward: lands AFTER the block it is over.
    expect(reorderHint(2, 5, 0)).toBe('ก่อนฉาก 4')
    expect(reorderHint(4, 5, 0)).toBe('ท้ายสุด')
    expect(reorderHint(1, 5, 1)).toBe('ตำแหน่งเดิม')
  })

  it('without an active index treats the slot as "before"', () => {
    expect(reorderHint(2, 5)).toBe('ก่อนฉาก 3')
    expect(reorderHint(5, 5)).toBe('ท้ายสุด')
    expect(reorderHint(-1, 5)).toBe('')
  })
})

describe('trimFrame', () => {
  const vo: SnapTarget = { sec: 12.52, kind: 'voiceover' }
  const common = {
    cut,
    startIn: 1,
    startOut: 3,
    minIn: 0,
    maxOut: 10,
    tolSec: 0.1,
    clock: 'output' as const,
    startOffsetSec: 10
  }

  it('quantizes to a frame when nothing snaps', () => {
    const r = trimFrame({ ...common, edge: 'right', deltaSec: 0.51, snapActive: true, targets: [] })
    // 3.51 s is not on the 30fps grid; 3.5 is (105 frames).
    expect(r.patch).toEqual({ out: 3.5 })
    expect(r.hit).toBeNull()
    expect(r.atLimit).toBe(false)
    expect(r.readout).toEqual({ deltaSec: 0.5, durationSec: 2.5, atLimit: false })
  })

  it('snaps AFTER quantizing, so an exact target beats the frame grid', () => {
    const r = trimFrame({
      ...common,
      edge: 'right',
      deltaSec: 0.5,
      snapActive: true,
      targets: [vo]
    })
    // The block spans 10–12.5 on the output clock; the VO line ends at 12.52.
    expect(r.patch.out).toBeCloseTo(3.52, 9)
    expect(r.hit?.target).toBe(vo)
  })

  it('snaps the left edge the same way', () => {
    const end: SnapTarget = { sec: 11.52, kind: 'cut', ownerId: 'other' }
    const r = trimFrame({
      ...common,
      edge: 'left',
      deltaSec: 0.5,
      snapActive: true,
      targets: [end]
    })
    // A left trim moves the block's END on the output clock (its start is
    // pinned by the scenes before it): 12 → 11.5 raw, snapped to 11.52, so
    // in = out − (11.52 − 10) = 1.48.
    expect(r.hit?.target).toBe(end)
    expect(r.patch.in).toBeCloseTo(1.48, 9)
    expect(r.patch.out).toBeUndefined()
    expect(r.readout.deltaSec).toBeCloseTo(0.48, 9)
  })

  it('never snaps to its own edges', () => {
    const own: SnapTarget = { sec: 12.52, kind: 'cut', ownerId: cut.id }
    const r = trimFrame({
      ...common,
      edge: 'right',
      deltaSec: 0.5,
      snapActive: true,
      targets: [own]
    })
    expect(r.patch).toEqual({ out: 3.5 })
    expect(r.hit).toBeNull()
  })

  it('does not snap when snapping is off (Alt held / toggle off)', () => {
    const r = trimFrame({
      ...common,
      edge: 'right',
      deltaSec: 0.5,
      snapActive: false,
      targets: [vo]
    })
    expect(r.patch).toEqual({ out: 3.5 })
    expect(r.hit).toBeNull()
  })

  it('clamps at the footage end and reports the limit, with no hit', () => {
    const r = trimFrame({
      ...common,
      edge: 'right',
      deltaSec: 9,
      snapActive: true,
      targets: [{ sec: 19.05, kind: 'voiceover' }]
    })
    expect(r.patch).toEqual({ out: 10 })
    expect(r.atLimit).toBe(true)
    expect(r.readout.atLimit).toBe(true)
    expect(r.hit).toBeNull()
  })

  it('keeps MIN_CUT_SEC without calling it a footage limit', () => {
    const r = trimFrame({ ...common, edge: 'left', deltaSec: 5, snapActive: true, targets: [] })
    expect(r.patch.in).toBeCloseTo(3 - MIN_CUT_SEC, 9)
    expect(r.atLimit).toBe(false)
  })

  it('reports the footage start on a left trim past 0', () => {
    const r = trimFrame({ ...common, edge: 'left', deltaSec: -5, snapActive: true, targets: [] })
    expect(r.patch).toEqual({ in: 0 })
    expect(r.atLimit).toBe(true)
  })
})

describe('quantizeDeltaToFrame', () => {
  it('keeps the sign a time quantizer would drop', () => {
    expect(quantizeDeltaToFrame(-0.4)).toBeCloseTo(-0.4, 9)
    expect(quantizeDeltaToFrame(0.4)).toBeCloseTo(0.4, 9)
    expect(quantizeDeltaToFrame(-0.001)).toBe(0)
  })
})

describe('pickMusicSnap', () => {
  const hit = { target: { sec: 5, kind: 'cut' as const }, distSec: 0.05 }

  it('takes whichever candidate moved the block less', () => {
    // Raw 4.95: the span snap moves 0.05, the beat snap 0.12.
    expect(pickMusicSnap(4.95, { start: 5, hit }, 5.07)).toEqual({
      offsetSec: 5,
      hit,
      beat: false
    })
    // Beat snap closer.
    expect(pickMusicSnap(4.95, { start: 5, hit }, 4.97)).toEqual({
      offsetSec: 4.97,
      hit: null,
      beat: true
    })
  })

  it('ignores a candidate that did not move the block', () => {
    expect(pickMusicSnap(4.95, { start: 4.95, hit: null }, 4.95)).toEqual({
      offsetSec: 4.95,
      hit: null,
      beat: false
    })
    expect(pickMusicSnap(4.95, { start: 4.95, hit: null }, 5.0)).toEqual({
      offsetSec: 5,
      hit: null,
      beat: true
    })
    expect(pickMusicSnap(4.95, { start: 5, hit }, null)).toEqual({ offsetSec: 5, hit, beat: false })
  })
})

describe('stripTileFor', () => {
  const strip = { count: 10, tileSec: 0.5 }

  it('picks the tile that contains the second', () => {
    expect(stripTileFor(strip, 0)).toBe(0)
    expect(stripTileFor(strip, 0.49)).toBe(0)
    expect(stripTileFor(strip, 0.5)).toBe(1)
    expect(stripTileFor(strip, 2.3)).toBe(4)
  })

  it('clamps to the strip and handles no strip', () => {
    expect(stripTileFor(strip, 99)).toBe(9)
    expect(stripTileFor(strip, -1)).toBe(0)
    expect(stripTileFor(null, 1)).toBeNull()
    expect(stripTileFor({ count: 0, tileSec: 0.5 }, 1)).toBeNull()
  })
})
