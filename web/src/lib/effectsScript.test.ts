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

  // talking_head reads the lines the render burns: the transcript on the SAVED
  // cut, with the user's caption edits laid over. A stored full list used to
  // win, and it described the cut as it was when the editor first opened.
  const words = [
    { word: 'สวัสดี', start: 0, end: 0.4 },
    { word: 'ค่ะ', start: 0.4, end: 0.7 },
    { word: 'วันนี้', start: 10, end: 10.5 }
  ]
  const clips = [{ id: 'clip0', file: 'a.mp4', durationSec: 20 }] as LocalProject['clips']

  it('derives talking_head lines from the words on the saved cut, output clock', () => {
    const project = baseProject({
      mode: 'talking_head',
      clips,
      timeline: {
        timeline: [{ type: 'cut', source: 'clip0', in: 10, out: 11, label: '' }],
        words
      }
    })
    // Only the cut's word, at OUTPUT time 0 — not source 10.
    expect(buildEffectsScriptText(project)).toBe('0.0s-0.5s: วันนี้')
  })

  it('lays a caption edit over the derived line', () => {
    const project = baseProject({
      mode: 'talking_head',
      clips,
      timeline: {
        timeline: [{ type: 'cut', source: 'clip0', in: 0, out: 1, label: '' }],
        words,
        captionLines: [
          {
            id: 'ed1',
            text: 'สวัสดีจ้า',
            start: 0,
            end: 0.7,
            edited: true,
            anchor: [{ source: 'clip0', in: 0, out: 0.7 }]
          }
        ]
      }
    })
    expect(buildEffectsScriptText(project)).toBe('0.0s-0.7s: สวัสดีจ้า')
  })

  it('keeps the hand-fixed text of a full list stored by an older build', () => {
    // Older builds stored every line, unmarked. A line whose text the
    // derivation does not say is a user's fix and must survive the upgrade.
    const project = baseProject({
      mode: 'talking_head',
      clips,
      timeline: {
        timeline: [{ type: 'cut', source: 'clip0', in: 0, out: 1, label: '' }],
        words,
        captionLines: [{ id: 'l1', text: 'ข้อความแก้เอง', start: 0, end: 1 }]
      }
    })
    expect(buildEffectsScriptText(project)).toBe('0.0s-1.0s: ข้อความแก้เอง')
  })

  it('re-derives an unmarked stored line the transcript still says', () => {
    const project = baseProject({
      mode: 'talking_head',
      clips,
      timeline: {
        timeline: [{ type: 'cut', source: 'clip0', in: 0, out: 1, label: '' }],
        words,
        // Stale timing, untouched text: not a fix, so the derivation wins.
        captionLines: [{ id: 'l1', text: 'สวัสดีค่ะ', start: 0.2, end: 1 }]
      }
    })
    expect(buildEffectsScriptText(project)).toBe('0.0s-0.7s: สวัสดีค่ะ')
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
