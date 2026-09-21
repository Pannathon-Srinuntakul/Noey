import { describe, expect, it } from 'vitest'
import { dubCutsFor, timelineCutsFor, timelineScenesFor } from './dubScenes'
import { editTimelineFromContext } from './editorApi'
import type { DubEditScript } from './videosLocalApi'

const script: DubEditScript = {
  mode: 'dub_first',
  totalEstimatedSec: 5,
  segments: [
    {
      sourceClip: 'clip0',
      sourceIn: 0,
      sourceOut: 2,
      durationSec: 2,
      voiceoverLineId: 1,
      voiceoverScript: 'หนึ่ง'
    },
    {
      sourceClip: 'clip1',
      sourceIn: 4,
      sourceOut: 7,
      durationSec: 3,
      voiceoverLineId: 2,
      voiceoverScript: 'สอง'
    }
  ]
}

describe('timelineScenesFor', () => {
  it('maps cut i to segment i when the cuts carry no line', () => {
    const planned = {
      mode: 'dub_first',
      timeline: [
        { type: 'cut', source: 'clip0', in: 0, out: 2.5, label: '' },
        { type: 'cut', source: 'clip1', in: 4, out: 7, label: '' }
      ]
    }
    expect(timelineScenesFor(planned, script).map((s) => [s.lineId, s.script])).toEqual([
      [1, 'หนึ่ง'],
      [2, 'สอง']
    ])
  })

  // After the editor reorders a voiced timeline, cut 0 is segment 1: the index
  // mapping put each line's caption over the other line's shots.
  it('uses the line an editor-saved cut carries', () => {
    const reordered = {
      mode: 'dub_first',
      timeline: [
        {
          type: 'cut',
          source: 'clip1',
          in: 4,
          out: 7,
          label: '',
          voiceoverLineId: 2,
          voiceoverScript: 'สอง'
        },
        {
          type: 'cut',
          source: 'clip0',
          in: 0,
          out: 2,
          label: '',
          voiceoverLineId: 1,
          voiceoverScript: 'หนึ่ง'
        }
      ]
    }
    expect(timelineScenesFor(reordered, script).map((s) => [s.lineId, s.script, s.start])).toEqual([
      [2, 'สอง', 0],
      [1, 'หนึ่ง', 3]
    ])
  })
})

describe('cut lists for caption anchors', () => {
  it('lays the silent cut on the same clock as dubScenesFor', () => {
    expect(dubCutsFor(script)).toEqual([
      { source: 'clip0', in: 0, out: 2 },
      { source: 'clip1', in: 4, out: 7 }
    ])
  })

  it('keeps only the planned timeline’s cuts', () => {
    expect(
      timelineCutsFor({
        mode: 'dub_first',
        timeline: [
          { type: 'cut', source: 'clip0', in: 1, out: 2, label: '' },
          { type: 'gap', source: 'clip0', in: 0, out: 0, label: '' }
        ]
      })
    ).toEqual([{ source: 'clip0', in: 1, out: 2 }])
  })
})

describe('editTimelineFromContext on a voiced dub', () => {
  it('gives each planned cut its voiceover line, the text on its first scene only', () => {
    const t = editTimelineFromContext({
      localUid: 'p',
      clips: [],
      editTarget: 'timeline',
      editScript: {
        ...script,
        segments: [...script.segments, { ...script.segments[0], voiceoverScript: '' }]
      },
      timeline: {
        mode: 'dub_first',
        timeline: [
          { type: 'cut', source: 'clip0', in: 0, out: 2, label: '' },
          { type: 'cut', source: 'clip1', in: 4, out: 7, label: '' },
          { type: 'cut', source: 'clip0', in: 2, out: 3, label: '' }
        ]
      },
      onSave: async () => undefined
    })
    expect(t.cuts.map((c) => [c.voiceoverLineId, c.voiceoverScript])).toEqual([
      [1, 'หนึ่ง'],
      [2, 'สอง'],
      [1, '']
    ])
  })
})
