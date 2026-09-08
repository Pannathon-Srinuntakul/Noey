import { describe, expect, it } from 'vitest'
import { dubSegmentsFromEditCuts, type EditCutIn } from './dubSegments'
import { editScriptFromCuts, editTimelineFromContext } from './editorApi'
import fixtures from './__fixtures__/dub_segments.json'

interface Fixture {
  cuts: EditCutIn[]
  segments: Record<string, unknown>[]
}

describe('dubSegmentsFromEditCuts (fixture parity with Python original)', () => {
  it('matches packages/video/timeline.py dub_segments_from_edit_cuts output', () => {
    for (const { cuts, segments } of fixtures as Fixture[]) {
      expect(dubSegmentsFromEditCuts(cuts)).toEqual(segments)
    }
  })
})

describe('editScriptFromCuts', () => {
  it('wraps segments with mode + totalEstimatedSec', () => {
    const es = editScriptFromCuts([
      { source: 'clip0', in: 0, out: 2, label: '', voiceoverLineId: 1, voiceoverScript: 'a' },
      { source: 'clip0', in: 3, out: 4.5, label: '', voiceoverLineId: 2, voiceoverScript: 'b' }
    ])
    expect(es.mode).toBe('dub_first')
    expect(es.totalEstimatedSec).toBe(3.5)
    expect(es.segments).toHaveLength(2)
  })
})

describe('editTimelineFromContext', () => {
  const clips = [
    {
      id: 'clip0',
      file: 'normalized/norm_000.mp4',
      durationSec: 10,
      width: 1080,
      height: 1920,
      fps: 30,
      hasAudio: true
    }
  ]

  it('edit_script target mirrors the server adapter (videos.py get_edit_timeline)', () => {
    const et = editTimelineFromContext({
      localUid: 'u1',
      clips,
      editTarget: 'edit_script',
      editScript: {
        segments: [
          {
            order: 2,
            sourceClip: 'clip0',
            sourceIn: 5,
            sourceOut: 7,
            voiceoverLineId: 2,
            voiceoverScript: 'b'
          },
          { order: 1, sourceClip: 'clip0', sourceIn: 0, sourceOut: 2, voiceoverLineId: 1 }
        ]
      },
      onSave: async () => undefined
    })
    expect(et.editTarget).toBe('edit_script')
    expect(et.sources).toEqual([{ id: 'clip0', durationSec: 10 }])
    // sorted by order, ids assigned sequentially, label = voiceoverLineId
    expect(et.cuts.map((c) => [c.id, c.in, c.out, c.label])).toEqual([
      ['cut0', 0, 2, '1'],
      ['cut1', 5, 7, '2']
    ])
  })

  it('timeline target maps raw timeline cuts', () => {
    const et = editTimelineFromContext({
      localUid: 'u1',
      clips,
      editTarget: 'timeline',
      timeline: {
        mode: 'dub_first',
        timeline: [{ type: 'cut', source: 'clip0', in: 1, out: 2, label: 'opening' }]
      },
      onSave: async () => undefined
    })
    expect(et.cuts).toEqual([{ id: 'cut0', source: 'clip0', in: 1, out: 2, label: 'opening' }])
  })
})
