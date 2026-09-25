/**
 * The resume contract as the web client reads it: a payload from the server
 * becomes a state nothing else has to defend against, and the sentences a
 * paused project shows are decided here rather than in a component.
 */
import { describe, expect, it } from 'vitest'
import {
  balanceLine,
  localFootageWarning,
  needsWalletConsent,
  nextStageLine,
  outcomeMessage,
  parseQuota,
  parseResumeOutcome,
  parseResumeState,
  pausedHeadline,
  resumeActionLabel,
  resumeBlockLine,
  resumeCostLine,
  stageLabel,
  stagePosition,
  stageStep,
  stepAfterResume,
  windowResetLine,
  type ResumeState
} from './resume'

const NOW = new Date('2026-09-26T10:00:00Z')

const DUB_STAGES = [
  'imported',
  'proxy',
  'analyze',
  'render_silent',
  'voiceover',
  'plan',
  'render_final',
  'done'
]

/** A paused dub project, exactly as the contract documents it. */
function pausedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'e9bf',
    status: 'paused_quota',
    mode: 'dub_first',
    paused: true,
    reason: 'quota',
    stage: 'proxy',
    next_stage: 'analyze',
    stages: DUB_STAGES,
    runs_on: 'server',
    client_step: null,
    paused_at: '2026-09-26T09:04:57.743684Z',
    window: 'five_hour',
    window_resets_at: '2026-09-26T11:48:00Z',
    message: 'โควตารอบนี้หมด ระบบหยุดงานไว้ให้',
    resumable: true,
    charges: true,
    estimate_source: 'ticket',
    quota: {
      fits: 'plan',
      pct: { weekly: 5.5, five_hour: 13.7 },
      wallet_satang: 0,
      balance_satang: 0,
      binding: null,
      resets_at: null,
      unlimited: false
    },
    ...over
  }
}

function state(over: Record<string, unknown> = {}): ResumeState {
  return parseResumeState(pausedPayload(over))
}

describe('parseResumeState', () => {
  it('reads the documented payload without losing anything', () => {
    const s = state()
    expect(s.paused).toBe(true)
    expect(s.stage).toBe('proxy')
    expect(s.nextStage).toBe('analyze')
    expect(s.stages).toEqual(DUB_STAGES)
    expect(s.runsOn).toBe('server')
    expect(s.window).toBe('five_hour')
    expect(s.windowResetsAt).toBe('2026-09-26T11:48:00Z')
    expect(s.estimateSource).toBe('ticket')
    expect(s.quota.pct).toEqual({ weekly: 5.5, five_hour: 13.7 })
  })

  it('trusts the status when an older build omits the flag', () => {
    const raw = pausedPayload()
    delete raw.paused
    expect(parseResumeState(raw).paused).toBe(true)
  })

  it('survives a payload that is not an object at all', () => {
    const s = parseResumeState(null)
    expect(s.paused).toBe(false)
    expect(s.stages).toEqual([])
    expect(s.quota.fits).toBe('plan')
    expect(s.resumable).toBe(false)
  })

  it('keeps the client step the server says to repeat', () => {
    const s = state({
      runs_on: 'client',
      next_stage: 'plan',
      client_step: {
        method: 'POST',
        path: '/videos/e9bf/plan-dub',
        body: { voDurationSec: 31.5 }
      }
    })
    expect(s.clientStep?.path).toBe('/videos/e9bf/plan-dub')
    expect(s.clientStep?.body.voDurationSec).toBe(31.5)
  })

  it('drops a client step with no path rather than half-believing it', () => {
    expect(state({ client_step: { method: 'POST' } }).clientStep).toBeNull()
  })

  it('ignores window keys it does not enforce', () => {
    const s = state({ window: 'daily', quota: { pct: { daily: 9, weekly: 4 } } })
    expect(s.window).toBeNull()
    expect(s.quota.pct).toEqual({ weekly: 4 })
  })
})

describe('parseQuota', () => {
  it('defaults an unreadable block to "the plan covers it"', () => {
    // A broken estimate must never push a top-up nobody needs: the server
    // refuses nothing here, it just parks the run again.
    expect(parseQuota(undefined).fits).toBe('plan')
    expect(parseQuota('nonsense').balance_satang).toBe(0)
  })
})

describe('parseResumeOutcome', () => {
  it('reads a server_job answer', () => {
    const o = parseResumeOutcome(
      pausedPayload({
        status: 'processing',
        paused: false,
        action: 'server_job',
        job_id: 'vlocal_a2330a55',
        run_id: 'ec9d',
        resumed: true,
        detail: null
      })
    )
    expect(o.action).toBe('server_job')
    expect(o.jobId).toBe('vlocal_a2330a55')
    expect(o.resumed).toBe(true)
  })

  it('treats an action it does not know as nothing to resume', () => {
    expect(parseResumeOutcome(pausedPayload({ action: 'teleport' })).action).toBe(
      'nothing_to_resume'
    )
  })
})

describe('stage vocabulary', () => {
  it('maps every boundary to the step the local pipeline calls it', () => {
    expect(stageStep('analyze', 'dub_first')).toBe('analyzing')
    expect(stageStep('render_silent', 'dub_first')).toBe('silent_rendering')
    expect(stageStep('transcribe', 'talking_head')).toBe('transcribing')
    expect(stageStep('select', 'speech_highlights')).toBe('selecting')
  })

  it('forks render_final the way the two chains do', () => {
    expect(stageStep('render_final', 'dub_first')).toBe('final_rendering')
    expect(stageStep('render_final', 'speech_scenes')).toBe('rendering')
  })

  it('has no local step for a side stage or an unknown one', () => {
    expect(stageStep('reedit', 'dub_first')).toBeNull()
    expect(stageStep('something_new', 'dub_first')).toBeNull()
    expect(stageStep(null, 'dub_first')).toBeNull()
  })

  it('still NAMES the side stages, because they can be next_stage', () => {
    expect(stageLabel('reedit')).toBe('ให้ AI ตัดใหม่')
    expect(stageLabel('effects')).toBe('เอฟเฟกต์การซูม')
  })

  it('takes the position from the server list, never a hardcoded order', () => {
    expect(stagePosition(state())).toBe('ขั้นที่ 3 จาก 8')
    // A speech project's order is shorter and its stages are different — the
    // same function has to answer for it with no extra knowledge.
    const speech = state({
      mode: 'speech_scenes',
      stages: ['imported', 'extract_audio', 'transcribe', 'select', 'render_final', 'done'],
      next_stage: 'select'
    })
    expect(stagePosition(speech)).toBe('ขั้นที่ 4 จาก 6')
  })

  it('says nothing about a position it cannot place', () => {
    expect(stagePosition(state({ next_stage: 'reedit' }))).toBeNull()
  })
})

describe('what a paused project says', () => {
  it('names the window that ran out', () => {
    expect(pausedHeadline(state())).toContain('โควตารอบ 5 ชั่วโมง')
  })

  it('says nothing for a project that is not paused', () => {
    expect(pausedHeadline(state({ paused: false, status: 'done' }))).toBe('')
  })

  it('writes the reset time in the viewer’s own terms', () => {
    // 1h48m out, so the sentence is a countdown rather than a date.
    expect(windowResetLine(state(), NOW)).toBe('โควตารอบ 5 ชั่วโมงจะรีเซ็ตอีก 1 ชม. 48 นาที')
  })

  it('has no reset line when the server froze no time', () => {
    expect(windowResetLine(state({ window_resets_at: null }), NOW)).toBe('')
  })

  it('says which stage continuing picks up', () => {
    expect(nextStageLine(state())).toBe('ทำต่อที่: ให้ AI วิเคราะห์วิดีโอ · ขั้นที่ 3 จาก 8')
    expect(nextStageLine(state({ next_stage: null }))).toBe('ไม่มีขั้นตอนค้างอยู่')
  })

  it('prices the next stage in percent of the windows, never in tokens', () => {
    // Fullest window first, whole percent, both windows named.
    expect(resumeCostLine(state())).toBe(
      'ใช้ประมาณ 14% ของโควตารอบ 5 ชั่วโมง · 6% ของโควตารายสัปดาห์'
    )
  })

  it('marks an estimate the server could only guess at', () => {
    expect(resumeCostLine(state({ estimate_source: 'declared' }))).toContain('ประมาณการคร่าว ๆ')
  })

  it('says a local next step costs nothing', () => {
    const s = state({ charges: false, runs_on: 'client', next_stage: 'render_silent' })
    expect(resumeCostLine(s)).toBe('ขั้นตอนถัดไปทำบนเครื่องนี้ — ไม่ใช้โควตาเพิ่ม')
    expect(resumeBlockLine(s)).toBeNull()
    expect(needsWalletConsent(s)).toBe(false)
  })
})

describe('the continue button', () => {
  const walletState = (): ResumeState =>
    state({
      quota: {
        fits: 'wallet',
        pct: { five_hour: 40 },
        wallet_satang: 1250,
        balance_satang: 30000,
        binding: 'five_hour',
        resets_at: '2026-09-26T11:48:00Z',
        unlimited: false
      }
    })

  it('offers the plain press while the plan can pay', () => {
    expect(resumeActionLabel(state())).toBe('ทำต่อ')
    expect(needsWalletConsent(state())).toBe(false)
  })

  it('names the amount when the balance is what pays', () => {
    const s = walletState()
    expect(needsWalletConsent(s)).toBe(true)
    expect(resumeActionLabel(s)).toBe('ใช้ยอดเงินคงเหลือ ฿12.50 ทำต่อ')
    expect(balanceLine(s)).toBe('ยอดเงินคงเหลือ ฿300.00')
    expect(resumeBlockLine(s, NOW)).toContain('฿12.50')
  })

  it('still offers a press when nothing can pay — the server parks it again', () => {
    const s = state({
      quota: {
        fits: 'none',
        pct: { five_hour: 90 },
        wallet_satang: 0,
        balance_satang: 0,
        binding: 'five_hour',
        resets_at: '2026-09-26T11:48:00Z',
        unlimited: false
      }
    })
    expect(resumeActionLabel(s)).toBe('ลองทำต่อ')
    expect(needsWalletConsent(s)).toBe(false)
  })

  it('says nothing about cost for an unlimited account', () => {
    const s = state({ quota: { fits: 'plan', pct: {}, unlimited: true } })
    expect(resumeCostLine(s)).toBeNull()
    expect(resumeBlockLine(s)).toBeNull()
  })
})

describe('the case that cannot work', () => {
  it('warns only when the next step is local AND the footage is not here', () => {
    const local = state({ runs_on: 'client', next_stage: 'render_silent' })
    expect(localFootageWarning(local, false)).toContain('เบราว์เซอร์')
    // Reachable, or not yet checked: no claim either way.
    expect(localFootageWarning(local, true)).toBeNull()
    expect(localFootageWarning(local, null)).toBeNull()
  })

  it('never warns about a stage the SERVER runs — it has the files', () => {
    expect(localFootageWarning(state(), false)).toBeNull()
  })
})

describe('after the POST', () => {
  const outcome = (over: Record<string, unknown>): ReturnType<typeof parseResumeOutcome> =>
    parseResumeOutcome(pausedPayload(over))

  it('tells the user what actually happened', () => {
    expect(outcomeMessage(outcome({ action: 'server_job' }))).toContain('ให้ AI วิเคราะห์วิดีโอ')
    expect(outcomeMessage(outcome({ action: 'already_running' }))).toBe('งานนี้กำลังทำอยู่แล้ว')
    expect(
      outcomeMessage(outcome({ action: 'nothing_to_resume', detail: 'ไม่มีขั้นตอนค้างอยู่' }))
    ).toBe('ไม่มีขั้นตอนค้างอยู่')
  })

  it('puts the project where the SERVER says it now is', () => {
    expect(stepAfterResume(outcome({ status: 'done' }), 'dub_first', 'imported')).toBe('done')
    expect(stepAfterResume(outcome({ status: 'waiting_vo' }), 'dub_first', 'imported')).toBe(
      'waiting_vo'
    )
    expect(
      stepAfterResume(
        outcome({ status: 'processing', next_stage: 'transcribe' }),
        'talking_head',
        'imported'
      )
    ).toBe('transcribing')
    // `pending` says only "nothing is running" — the caller's own resting step.
    expect(stepAfterResume(outcome({ status: 'pending' }), 'dub_first', 'waiting_vo')).toBe(
      'waiting_vo'
    )
  })
})
