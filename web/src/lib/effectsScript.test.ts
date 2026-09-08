import { describe, expect, it } from 'vitest'
import { buildEffectsScriptText } from './effectsScript'
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

describe('buildEffectsScriptText', () => {
  it('returns empty string when no script/timeline data', () => {
    expect(buildEffectsScriptText(baseProject({ mode: 'dub_first' }))).toBe('')
  })

  it('builds timed lines from a dub_first edit script', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          {
            order: 0,
            voiceoverLineId: 1,
            sourceIn: 0,
            sourceOut: 2,
            durationSec: 2,
            voiceoverScript: 'ลดราคาวันนี้'
          },
          {
            order: 1,
            voiceoverLineId: 2,
            sourceIn: 2,
            sourceOut: 5,
            durationSec: 3,
            voiceoverScript: 'รองเท้าคู่นี้ดีมาก'
          }
        ]
      } as unknown as Record<string, unknown>
    })
    const text = buildEffectsScriptText(project)
    expect(text).toContain('0.0s-2.0s: ลดราคาวันนี้')
    expect(text).toContain('2.0s-5.0s: รองเท้าคู่นี้ดีมาก')
  })

  it('prefers saved captionLines for talking_head', () => {
    const project = baseProject({
      mode: 'talking_head',
      timeline: {
        captionLines: [{ id: 'l1', text: 'สวัสดีค่ะ', start: 0, end: 1.5 }]
      }
    })
    expect(buildEffectsScriptText(project)).toBe('0.0s-1.5s: สวัสดีค่ะ')
  })

  it('falls back to raw words for talking_head when no captionLines', () => {
    const project = baseProject({
      mode: 'talking_head',
      timeline: {
        words: [
          { word: 'สวัสดี', start: 0, end: 0.4 },
          { word: 'ค่ะ', start: 0.4, end: 0.7 }
        ]
      }
    })
    const text = buildEffectsScriptText(project)
    expect(text).toContain('0.0s-0.7s')
  })

  it('drops blank lines', () => {
    const project = baseProject({
      mode: 'talking_head',
      timeline: { captionLines: [{ id: 'l1', text: '   ', start: 0, end: 1 }] }
    })
    expect(buildEffectsScriptText(project)).toBe('')
  })

  it('falls back to [scene] visualDescription when a line has no voiceoverScript', () => {
    const project = baseProject({
      mode: 'dub_first',
      editScript: {
        segments: [
          {
            order: 0,
            voiceoverLineId: 1,
            sourceIn: 0,
            sourceOut: 2,
            durationSec: 2,
            visualDescription: 'ถือสินค้าใกล้กล้อง โลโก้ชัด'
          }
        ]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsScriptText(project)).toBe('0.0s-2.0s: [scene] ถือสินค้าใกล้กล้อง โลโก้ชัด')
  })

  it('builds [scene]-only lines for highlight mode (no voiceoverScript ever)', () => {
    const project = baseProject({
      mode: 'highlight',
      editScript: {
        segments: [
          {
            order: 0,
            voiceoverLineId: 1,
            sourceIn: 0,
            sourceOut: 2,
            durationSec: 2,
            visualDescription: 'close-up เนื้อสินค้า'
          },
          {
            order: 1,
            voiceoverLineId: 2,
            sourceIn: 2,
            sourceOut: 5,
            durationSec: 3,
            visualDescription: 'on-body demo'
          }
        ]
      } as unknown as Record<string, unknown>
    })
    const text = buildEffectsScriptText(project)
    expect(text).toBe('0.0s-2.0s: [scene] close-up เนื้อสินค้า\n2.0s-5.0s: [scene] on-body demo')
  })

  it('a line with neither voiceoverScript nor visualDescription drops out', () => {
    const project = baseProject({
      mode: 'highlight',
      editScript: {
        segments: [{ order: 0, voiceoverLineId: 1, sourceIn: 0, sourceOut: 2, durationSec: 2 }]
      } as unknown as Record<string, unknown>
    })
    expect(buildEffectsScriptText(project)).toBe('')
  })
})
