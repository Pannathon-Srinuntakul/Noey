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

describe('segment fields the editor does not model survive a save', () => {
  // Live report 2026-09-21: opening the editor autosaved within 2s, the save
  // rebuilt every segment from the editor's own fields, and ปรับช็อต went empty.
  const segments = [
    {
      order: 1,
      voiceoverLineId: 1,
      sourceClip: 'clip0',
      sourceIn: 5,
      sourceOut: 8,
      durationSec: 3,
      matchedFrameTime: 5.2,
      visualDescription: 'ถือสินค้าใกล้กล้อง',
      cutStyle: 'zoom_in',
      voiceoverScript: 'วันนี้มารีวิว',
      alternates: [
        {
          sourceClip: 'clip0',
          sourceIn: 31,
          sourceOut: 34,
          matchedFrameTime: 31.2,
          note: 'ชิดกว่า'
        }
      ]
    }
  ]

  it('round-trips alternates, matchedFrameTime and visualDescription', async () => {
    const { editCutsFromDubSegments } = await import('./editorApi')
    const cuts = editCutsFromDubSegments(segments)
    expect(cuts[0].meta).toEqual({
      matchedFrameTime: 5.2,
      visualDescription: 'ถือสินค้าใกล้กล้อง',
      alternates: segments[0].alternates
    })
    const saved = editScriptFromCuts(cuts.map(({ id: _id, ...rest }) => rest)).segments[0]
    expect(saved.alternates).toEqual(segments[0].alternates)
    expect(saved.matchedFrameTime).toBe(5.2)
    expect(saved.visualDescription).toBe('ถือสินค้าใกล้กล้อง')
  })

  it('lets the edited fields win over the carried ones', () => {
    const [seg] = dubSegmentsFromEditCuts([
      {
        source: 'clip0',
        in: 6,
        out: 9,
        voiceoverLineId: 2,
        meta: { sourceIn: 5, durationSec: 3, alternates: [] }
      }
    ])
    expect(seg.sourceIn).toBe(6)
    expect(seg.durationSec).toBe(3)
    expect(seg.voiceoverLineId).toBe(2)
    expect(seg.alternates).toEqual([])
  })
})
