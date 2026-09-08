import { describe, expect, it } from 'vitest'
import {
  HL_STEP_ORDER,
  STEP_ORDER,
  TH_STEP_ORDER,
  isBusy,
  isTerminal,
  progressPercent,
  progressStagesFor,
  resumeStep,
  stepOrderFor
} from './projectFlow'
import { groupScriptLines } from './dubScript'

describe('projectFlow', () => {
  it('terminal and busy classification', () => {
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('error')).toBe(true)
    // The silent cut IS the deliverable — the voiceover is optional work
    // offered afterwards, not a stage the project is stuck inside.
    expect(isTerminal('waiting_vo')).toBe(true)
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

  it('talking_head has its own step order', () => {
    expect(stepOrderFor('talking_head')).toBe(TH_STEP_ORDER)
    expect(stepOrderFor('dub_first')).toBe(STEP_ORDER)
    expect(stepOrderFor(undefined)).toBe(STEP_ORDER)
    expect(TH_STEP_ORDER).toEqual([
      'importing',
      'imported',
      'extracting_audio',
      'transcribing',
      'rendering',
      'done'
    ])
  })

  it('talking_head busy + resume', () => {
    expect(isBusy('extracting_audio')).toBe(true)
    expect(isBusy('transcribing')).toBe(true)
    expect(isBusy('rendering')).toBe(true)
    expect(resumeStep('extracting_audio')).toBe('imported')
    expect(resumeStep('transcribing')).toBe('imported')
    expect(resumeStep('rendering')).toBe('rendering')
  })

  it('highlight has its own step order — no waiting_vo/planning/final_rendering', () => {
    expect(stepOrderFor('highlight')).toBe(HL_STEP_ORDER)
    expect(HL_STEP_ORDER).toEqual([
      'importing',
      'imported',
      'analyzing',
      'silent_rendering',
      'done'
    ])
  })

  it('highlight busy + resume', () => {
    expect(isBusy('analyzing')).toBe(true)
    expect(isBusy('silent_rendering')).toBe(true)
    expect(resumeStep('analyzing')).toBe('imported')
    expect(resumeStep('silent_rendering')).toBe('silent_rendering')
  })

  it('a dub run is four stages and ends at waiting_vo', () => {
    // planning/final_rendering are NOT here: they only happen if the user
    // records a voiceover, and listing them left two pips greyed out forever.
    expect(progressStagesFor('dub_first')).toEqual([
      'imported',
      'analyzing',
      'silent_rendering',
      'waiting_vo'
    ])
    expect(progressStagesFor('talking_head')).toEqual([
      'imported',
      'extracting_audio',
      'transcribing',
      'rendering'
    ])
    expect(progressStagesFor('highlight')).toEqual(['imported', 'analyzing', 'silent_rendering'])
  })

  it('the voiceover tail is opt-in, for the render that is actually running', () => {
    // Without this, `stages.indexOf('planning')` is -1 on the progress screen
    // and the bar sits at 0% for the whole voiced render.
    expect(progressStagesFor('dub_first', { withVoiceover: true })).toEqual([
      'imported',
      'analyzing',
      'silent_rendering',
      'waiting_vo',
      'planning',
      'final_rendering'
    ])
    // The flag is meaningless for the modes that have no voiceover step.
    expect(progressStagesFor('highlight', { withVoiceover: true })).toEqual(
      progressStagesFor('highlight')
    )
  })

  it('a finished cut reads as finished, and the voiced tail keeps moving', () => {
    expect(progressPercent('waiting_vo', 'dub_first')).toBe(100)
    expect(progressPercent('done', 'dub_first')).toBe(100)
    expect(progressPercent('analyzing', 'dub_first')).toBe(25)
    // Resolved against the extended list rather than falling into the
    // "unknown step → 0%" arm.
    expect(progressPercent('planning', 'dub_first')).toBeGreaterThan(0)
    expect(progressPercent('final_rendering', 'dub_first')).toBeGreaterThan(
      progressPercent('planning', 'dub_first')
    )
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
      {
        lineId: 1,
        script: 'เปิดคลิป',
        visualDescription: '',
        cutCount: 1,
        outputIn: 0,
        outputOut: 0
      },
      {
        lineId: 2,
        script: 'ช่วงกลาง',
        visualDescription: '',
        cutCount: 2,
        outputIn: 0,
        outputOut: 0
      },
      { lineId: 3, script: 'CTA', visualDescription: '', cutCount: 1, outputIn: 0, outputOut: 0 }
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
