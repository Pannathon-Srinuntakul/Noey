import { describe, expect, it } from 'vitest'
import { estimateKey, estimateRequestFor, startDecision } from './usageEstimate'
import type { UsageEstimate } from './usageLimits'
import { WIZARD_INITIAL, toWizardFile, type WizardFile } from './wizardState'

function file(durationSec: number | null): WizardFile {
  return { ...toWizardFile({ path: `p${durationSec}`, name: 'a.mp4' }), durationSec }
}

describe('estimateRequestFor', () => {
  it('waits for files and for every duration', () => {
    expect(estimateRequestFor({ ...WIZARD_INITIAL, files: [] })).toBeNull()
    expect(estimateRequestFor({ ...WIZARD_INITIAL, files: [file(10), file(null)] })).toBeNull()
  })

  it('sends the backend mode, the tiers and every clip', () => {
    const req = estimateRequestFor({
      ...WIZARD_INITIAL,
      uiMode: 'highlight',
      voiceover: 'none',
      engine: 'lite',
      precision: 'high',
      files: [file(34.2), file(12)]
    })
    expect(req).toEqual({
      mode: 'highlight',
      engine: 'lite',
      precision: 'high',
      clips: [
        { duration_sec: 34.2, has_audio: true },
        { duration_sec: 12, has_audio: true }
      ]
    })
  })

  it('maps the silence-cut mode to the transcription route', () => {
    expect(
      estimateRequestFor({ ...WIZARD_INITIAL, uiMode: 'silence', files: [file(5)] })?.mode
    ).toBe('talking_head')
  })

  it('keys equal requests equally', () => {
    const a = estimateRequestFor({ ...WIZARD_INITIAL, files: [file(5)] })
    const b = estimateRequestFor({ ...WIZARD_INITIAL, files: [file(5)] })
    expect(estimateKey(a)).toBe(estimateKey(b))
    expect(estimateKey(null)).toBe('')
  })
})

describe('startDecision', () => {
  const est = (fits: UsageEstimate['fits'], unlimited = false): UsageEstimate => ({
    fits,
    pct: { weekly: 50 },
    wallet_satang: fits === 'wallet' ? 500 : 0,
    binding: 'weekly',
    resets_at: null,
    unlimited
  })

  it('goes when it fits, or when nothing is known', () => {
    expect(startDecision(est('plan'), false)).toBe('go')
    expect(startDecision(null, false)).toBe('go')
    expect(startDecision(est('none', true), false)).toBe('go')
  })

  it('asks before spending the balance', () => {
    expect(startDecision(est('wallet'), false)).toBe('ask_wallet')
    expect(startDecision(est('wallet'), true)).toBe('go')
  })

  it('blocks before upload when nothing can pay', () => {
    expect(startDecision(est('none'), false)).toBe('blocked')
    expect(startDecision(est('none'), true)).toBe('blocked')
  })
})
