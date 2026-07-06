import { describe, expect, it } from 'vitest'
import {
  STEP_ORDER,
  TH_STEP_ORDER,
  advance,
  isBusy,
  isTerminal,
  resumeStep,
  stepIndex,
  stepOrderFor
} from './projectFlow'
import { groupScriptLines } from './dubScript'

describe('projectFlow', () => {
  it('advance walks the step order and stops at done', () => {
    expect(advance('imported')).toBe('analyzing')
    expect(advance('analyzing')).toBe('silent_rendering')
    expect(advance('waiting_vo')).toBe('planning')
    expect(advance('done')).toBe('done')
    expect(advance('error')).toBe('error') // not in order → unchanged
  })

  it('terminal and busy classification', () => {
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('error')).toBe(true)
    expect(isTerminal('waiting_vo')).toBe(false)
    expect(isBusy('analyzing')).toBe(true)
    expect(isBusy('final_rendering')).toBe(true)
    expect(isBusy('waiting_vo')).toBe(false)
    expect(isBusy('imported')).toBe(false)
  })

  it('interrupted background steps resume from a safe checkpoint', () => {
    expect(resumeStep('analyzing')).toBe('imported')
    expect(resumeStep('planning')).toBe('waiting_vo')
    expect(resumeStep('final_rendering')).toBe('waiting_vo')
    expect(resumeStep('silent_rendering')).toBe('silent_rendering')
    expect(resumeStep('waiting_vo')).toBe('waiting_vo')
    expect(resumeStep('done')).toBe('done')
  })

  it('stepIndex is monotonic over the order', () => {
    const indexes = STEP_ORDER.map((s) => stepIndex(s))
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
    expect(stepIndex('error')).toBe(0)
  })

  it('talking_head has its own step order', () => {
    expect(stepOrderFor('talking_head')).toBe(TH_STEP_ORDER)
    expect(stepOrderFor('dub_first')).toBe(STEP_ORDER)
    expect(stepOrderFor(undefined)).toBe(STEP_ORDER)
    expect(TH_STEP_ORDER).toEqual([
      'imported',
      'extracting_audio',
      'transcribing',
      'rendering',
      'done'
    ])
  })

  it('talking_head advance + busy + resume', () => {
    expect(advance('imported', 'talking_head')).toBe('extracting_audio')
    expect(advance('transcribing', 'talking_head')).toBe('rendering')
    expect(advance('done', 'talking_head')).toBe('done')
    expect(isBusy('extracting_audio')).toBe(true)
    expect(isBusy('transcribing')).toBe(true)
    expect(isBusy('rendering')).toBe(true)
    expect(resumeStep('extracting_audio')).toBe('imported')
    expect(resumeStep('transcribing')).toBe('imported')
    expect(resumeStep('rendering')).toBe('rendering')
  })
})

describe('groupScriptLines', () => {
  it('groups montage cuts under one voiceover line', () => {
    const lines = groupScriptLines({
      segments: [
        { order: 1, voiceoverLineId: 1, voiceoverScript: 'เปิดคลิป' },
        { order: 2, voiceoverLineId: 2, voiceoverScript: 'ช่วงกลาง' },
        { order: 3, voiceoverLineId: 2 }, // second angle, no script
        { order: 4, voiceoverLineId: 3, voiceoverScript: 'CTA' }
      ]
    })
    expect(lines).toEqual([
      { lineId: 1, script: 'เปิดคลิป', cutCount: 1 },
      { lineId: 2, script: 'ช่วงกลาง', cutCount: 2 },
      { lineId: 3, script: 'CTA', cutCount: 1 }
    ])
  })

  it('falls back to order when voiceoverLineId missing', () => {
    const lines = groupScriptLines({
      segments: [
        { order: 1, voiceoverScript: 'a' },
        { order: 2, voiceoverScript: 'b' }
      ]
    })
    expect(lines.map((l) => l.lineId)).toEqual([1, 2])
  })
})
