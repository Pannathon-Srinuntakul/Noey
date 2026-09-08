import { describe, expect, it } from 'vitest'

import { groupScriptLines, retimeLinesToCuts } from './dubScript'
import type { DubEditScript } from './videosLocalApi'

const EDIT_SCRIPT: DubEditScript = {
  mode: 'dub_first',
  segments: [
    { order: 1, voiceoverLineId: 1, durationSec: 2, voiceoverScript: 'บรรทัดหนึ่ง' },
    { order: 2, voiceoverLineId: 1, durationSec: 1, voiceoverScript: '' },
    { order: 3, voiceoverLineId: 2, durationSec: 3, voiceoverScript: 'บรรทัดสอง' }
  ]
}

describe('groupScriptLines', () => {
  it('merges the scenes of one spoken line into a single range', () => {
    const lines = groupScriptLines(EDIT_SCRIPT)
    expect(lines.map((l) => l.lineId)).toEqual([1, 2])
    expect(lines[0]).toMatchObject({ cutCount: 2, outputIn: 0, outputOut: 3 })
    expect(lines[1]).toMatchObject({ outputIn: 3, outputOut: 6 })
  })
})

describe('retimeLinesToCuts', () => {
  it('re-times lines onto the planned cuts, not the silent cut', () => {
    // The plan stretches/shrinks every scene to fit the recorded voiceover, so
    // the edit script's own clock stops describing the video being watched.
    const lines = retimeLinesToCuts(EDIT_SCRIPT, [
      { type: 'cut', in: 0, out: 4 },
      { type: 'cut', in: 10, out: 12 },
      { type: 'cut', in: 20, out: 25 }
    ])
    expect(lines[0]).toMatchObject({ lineId: 1, cutCount: 2, outputIn: 0, outputOut: 6 })
    expect(lines[1]).toMatchObject({ lineId: 2, outputIn: 6, outputOut: 11 })
  })

  it('ignores non-cut timeline entries', () => {
    const lines = retimeLinesToCuts(EDIT_SCRIPT, [
      { type: 'gap', in: 0, out: 99 },
      { type: 'cut', in: 0, out: 4 }
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ lineId: 1, outputIn: 0, outputOut: 4 })
  })

  it('falls back to the edit script when there is nothing to map onto', () => {
    expect(retimeLinesToCuts(EDIT_SCRIPT, [])).toEqual(groupScriptLines(EDIT_SCRIPT))
  })
})
