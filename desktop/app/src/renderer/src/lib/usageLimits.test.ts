import { describe, expect, it } from 'vitest'
import {
  checkoutAlreadyCredited,
  deviceId,
  durationTh,
  estimateBlockLine,
  OVERAGE_TOO_LARGE_LINE,
  overageLine,
  estimateLine,
  formatBaht,
  formatPack,
  isWaitingSlot,
  LEDGER_LABELS,
  jobStopRefusal,
  limitLabel,
  meterCopy,
  orderedMethods,
  runCostChip,
  runCostLine,
  runSharePct,
  parseRefusal,
  pctText,
  planName,
  queueNotice,
  refusalMessage,
  resetLine,
  shortDate,
  storageText,
  TRIAL_CREDIT_LEFT,
  TRIAL_CREDIT_SPENT,
  usageTone,
  whenBack,
  windowLine,
  windowTitle,
  type UsageEstimate
} from './usageLimits'

const NOW = new Date('2026-09-22T10:00:00Z') // a Tuesday

describe('labels', () => {
  it('names every window in Thai, per the editor design', () => {
    expect(limitLabel('monthly')).toBe('โควตารายเดือน')
    expect(limitLabel('weekly')).toBe('โควตารายสัปดาห์')
    expect(limitLabel('five_hour')).toBe('โควตารอบ 5 ชั่วโมง')
    expect(limitLabel('nonsense')).toBe('โควตา')
  })

  it('names plans', () => {
    expect(planName('free')).toBe('ฟรี')
    expect(planName('PRO')).toBe('Pro')
    expect(planName('custom')).toBe('custom')
    expect(planName(null)).toBe('ฟรี')
  })

  it('shows whole percents and keeps an overshoot visible', () => {
    expect(pctText(18.46)).toBe('18%')
    expect(pctText(104.2)).toBe('104%')
    expect(pctText(-3)).toBe('0%')
    expect(pctText(null)).toBe('0%')
  })

  it('colours by the design thresholds', () => {
    expect(usageTone(79.9)).toBe('ink')
    expect(usageTone(80)).toBe('accent')
    expect(usageTone(95)).toBe('error')
  })
})

describe('reset times in the viewer timezone', () => {
  it('five_hour counts down', () => {
    expect(resetLine('five_hour', '2026-09-22T11:48:00Z', NOW)).toBe('รอบใหม่ใน 1 ชม. 48 นาที')
    expect(resetLine('five_hour', '2026-09-22T10:00:20Z', NOW)).toBe('รอบใหม่ใน 1 นาที')
  })

  it('weekly names weekday and time in the given zone', () => {
    const iso = '2026-09-24T02:40:00Z' // Thu 09:40 in Bangkok, Thu 02:40 UTC
    expect(resetLine('weekly', iso, NOW, 'Asia/Bangkok')).toBe('รอบใหม่ พฤหัสบดี 09:40')
    expect(resetLine('weekly', iso, NOW, 'UTC')).toBe('รอบใหม่ พฤหัสบดี 02:40')
  })

  it('the same instant lands on a different day in another zone', () => {
    const iso = '2026-09-30T20:00:00Z'
    expect(resetLine('monthly', iso, NOW, 'Asia/Bangkok')).toBe('รีเซ็ต 1 ต.ค.')
    expect(resetLine('monthly', iso, NOW, 'UTC')).toBe('รีเซ็ต 30 ก.ย.')
  })

  it('an inactive window starts at the next use', () => {
    expect(resetLine('weekly', null, NOW)).toBe('เริ่มนับรอบใหม่เมื่อใช้งานครั้งถัดไป')
    expect(resetLine('weekly', 'garbage', NOW)).toBe('เริ่มนับรอบใหม่เมื่อใช้งานครั้งถัดไป')
  })

  it('whenBack picks the shape by distance', () => {
    expect(whenBack('2026-09-22T11:48:00Z', NOW)).toBe('อีก 1 ชม. 48 นาที')
    expect(whenBack('2026-09-24T02:40:00Z', NOW, 'Asia/Bangkok')).toBe('พฤหัสบดี 09:40')
    expect(whenBack('2026-10-10T00:00:00Z', NOW, 'Asia/Bangkok')).toBe('10 ต.ค.')
    expect(whenBack(null, NOW)).toBe('')
  })

  it('durations never read zero', () => {
    expect(durationTh(0)).toBe('1 นาที')
    expect(durationTh(2 * 3_600_000)).toBe('2 ชม.')
  })
})

describe('money', () => {
  it('formats a balance with satang and a pack without', () => {
    expect(formatBaht(29950)).toBe('฿299.50')
    expect(formatBaht(100000)).toBe('฿1,000.00')
    expect(formatPack(100000)).toBe('฿1,000')
    expect(formatPack(10000)).toBe('฿100')
  })

  it('writes storage the way the usage card shows it', () => {
    const GB = 1024 ** 3
    expect(storageText(6.2 * GB, 10 * GB)).toBe('6.2 / 10 GB')
    expect(storageText(0, 1 * GB)).toBe('0 / 1 GB')
    expect(storageText(2.5 * GB, 0)).toBe('2.5 GB · ไม่จำกัด')
    expect(shortDate('2026-09-25T20:00:00Z', 'Asia/Bangkok')).toBe('26 ก.ย.')
    expect(shortDate(null)).toBe('')
  })

  it('names every wallet movement the server sends, a reversed top-up included', () => {
    for (const kind of ['purchase', 'debit', 'refund', 'expire', 'adjust', 'reversal']) {
      expect(LEDGER_LABELS[kind]).toBeTruthy()
    }
    expect(LEDGER_LABELS.reversal).toBe('ยกเลิกการเติมเงิน')
  })

  it('offers PromptPay first', () => {
    expect(orderedMethods(['card', 'promptpay'])).toEqual(['promptpay', 'card'])
  })

  it('knows a mock credit from a real checkout', () => {
    expect(checkoutAlreadyCredited('http://localhost:3002/settings?tab=usage&topup=success')).toBe(
      true
    )
    expect(checkoutAlreadyCredited('https://checkout.example.com/c/pay/cs_test_1')).toBe(false)
    expect(checkoutAlreadyCredited('not a url')).toBe(false)
  })
})

describe('what a run costs — a percentage, never a count', () => {
  const est = (over: Partial<UsageEstimate> = {}): UsageEstimate => ({
    fits: 'plan',
    pct: { monthly: 4.6 },
    wallet_satang: 0,
    binding: 'monthly',
    resets_at: null,
    unlimited: false,
    ...over
  })

  it('prices the run against the window it is charged to', () => {
    expect(runSharePct(est())).toBe(5)
    expect(runCostLine(est())).toBe('งานนี้ใช้ประมาณ 5% ของโควตารายเดือน')
    expect(runCostChip(est())).toBe('~5%')
  })

  it('names whichever window is binding, not always the month', () => {
    const weekly = est({ binding: 'weekly', pct: { weekly: 11.8, monthly: 3 } })
    expect(runCostLine(weekly)).toBe('งานนี้ใช้ประมาณ 12% ของโควตารายสัปดาห์')
    const trial = est({ binding: 'lifetime', pct: { lifetime: 50 } })
    expect(runCostLine(trial)).toBe('งานนี้ใช้ประมาณ 50% ของเครดิตทดลองใช้')
    // A payload that named no binding window falls back to the fullest one.
    expect(runSharePct(est({ binding: null, pct: { weekly: 2, five_hour: 40 } }))).toBe(40)
  })

  it('floors at 1% so a cheap run never reads as free', () => {
    expect(runSharePct(est({ pct: { monthly: 0.2 } }))).toBe(1)
    expect(runCostLine(est({ pct: { monthly: 0.2 } }))).toContain('1%')
  })

  it('says nothing at all when nothing can answer', () => {
    expect(runSharePct(null)).toBeNull()
    expect(runCostLine(null)).toBeNull()
    expect(runCostChip(undefined)).toBeNull()
    expect(runSharePct(est({ unlimited: true }))).toBeNull()
    expect(runSharePct(est({ pct: {} }))).toBeNull()
    expect(runSharePct(est({ binding: null, pct: {} }))).toBeNull()
  })
})

describe('the meter is percent-only and can never drift back to counting', () => {
  // The reversal of 2026-09-29: a cut's cost varies more than fourfold with
  // its length and quality, so a countable meter drops by four on one upload
  // and reads as broken. "คลิป" is also this codebase's word for a SOURCE
  // video file, which a unit of spending may not also mean.
  const cases = [0, 0.4, 18.2, 50, 99.9, 100, 140]
  const kinds = [
    { key: 'monthly' as const, resets: undefined },
    { key: 'weekly' as const, resets: true },
    { key: 'lifetime' as const, resets: false }
  ]

  it('never writes a count of clips, at any fill, on any window', () => {
    for (const { key, resets } of kinds) {
      for (const used_pct of cases) {
        const copy = meterCopy(
          { key, used_pct, resets_at: '2026-09-22T11:48:00Z', active: true, resets },
          NOW
        )
        expect(`${copy.value} ${copy.line}`).not.toMatch(/คลิป/)
        expect(copy.value).toBe(`ใช้ไป ${pctText(used_pct)}`)
      }
    }
  })

  it('keeps the reset line for a window and the upgrade for a credit', () => {
    const w = {
      key: 'weekly' as const,
      used_pct: 18.2,
      resets_at: '2026-09-22T11:48:00Z',
      active: true
    }
    expect(meterCopy(w, NOW)).toEqual({
      value: 'ใช้ไป 18%',
      line: resetLine('weekly', w.resets_at, NOW)
    })
    expect(
      meterCopy(
        { key: 'lifetime', used_pct: 50, resets_at: null, active: true, resets: false },
        NOW
      )
    ).toEqual({ value: 'ใช้ไป 50%', line: 'ใช้หมดแล้วอัปเกรด' })
  })

  it('names the one-time credit, which is a window key of its own now', () => {
    expect(limitLabel('lifetime')).toBe('เครดิตทดลองใช้')
    expect(parseRefusal({ detail: { code: 'limit_reached', window: 'lifetime' } })?.window).toBe(
      'lifetime'
    )
  })
})

describe('an allowance that never resets (the Free trial credit)', () => {
  const credit = (used: number): Parameters<typeof windowLine>[0] => ({
    key: 'monthly',
    used_pct: used,
    // The server still sends a time; it is meaningless here and must not be
    // shown — left as-is, this is the "รีเซ็ตใน 0 วินาที" a free user saw forever.
    resets_at: '2026-09-22T09:00:00Z',
    active: true,
    resets: false
  })

  it('never counts down to a reset that does not come', () => {
    expect(windowLine(credit(100), NOW)).toBe(TRIAL_CREDIT_SPENT)
    expect(windowLine(credit(40), NOW)).toBe(TRIAL_CREDIT_LEFT)
    expect(windowLine(credit(100), NOW)).not.toMatch(/รีเซ็ต|รอบใหม่/)
  })

  it('is not called a monthly quota — that name is the untrue part', () => {
    expect(windowTitle(credit(10))).toBe('เครดิตทดลองใช้')
    expect(windowTitle({ key: 'monthly' })).toBe('โควตารายเดือน')
  })

  it('leaves a normal window exactly as it was', () => {
    const w = {
      key: 'five_hour' as const,
      used_pct: 40,
      resets_at: '2026-09-22T11:48:00Z',
      active: true
    }
    expect(windowLine(w, NOW)).toBe(resetLine('five_hour', w.resets_at, NOW))
    // An older server omits the flag; absent means it does reset.
    expect(windowLine({ ...w, resets: undefined }, NOW)).toBe(windowLine(w, NOW))
  })

  it('offers the plan change where a refusal would have named a reset time', () => {
    const r = parseRefusal({
      detail: {
        code: 'limit_reached',
        window: 'monthly',
        resets_at: '2026-09-22T09:00:00Z',
        resets: false,
        wallet_can_cover: false
      }
    })!
    expect(r.resets).toBe(false)
    expect(refusalMessage(r, NOW)).toBe('เครดิตทดลองใช้หมดแล้ว · เปลี่ยนแผนเพื่อใช้ต่อ')
    expect(refusalMessage(r, NOW)).not.toMatch(/เริ่มงานใหม่ได้/)
  })

  it('says the same in the pre-flight estimate', () => {
    const est: UsageEstimate = {
      fits: 'none',
      pct: { monthly: 90 },
      wallet_satang: 0,
      binding: 'monthly',
      resets_at: '2026-09-22T09:00:00Z',
      resets: false,
      unlimited: false
    }
    expect(estimateBlockLine(est, NOW)).toBe(
      'งานนี้อาจใช้เกินเครดิตทดลอง ส่วนที่เกินจะนับรวมเมื่อสมัครแพลน'
    )
    expect(estimateBlockLine({ ...est, full: true }, NOW)).toBe(
      'เครดิตทดลองใช้หมดแล้ว · เปลี่ยนแผนเพื่อใช้ต่อ'
    )
    expect(estimateBlockLine(est, NOW)).not.toMatch(/รอบใหม่/)
  })
})

describe('estimate lines', () => {
  const base: UsageEstimate = {
    fits: 'plan',
    pct: { weekly: 18.2 },
    wallet_satang: 0,
    binding: 'weekly',
    resets_at: null,
    unlimited: false
  }

  it('says how much of the limit a run uses', () => {
    expect(estimateLine(base)).toBe('ใช้ประมาณ 18% ของโควตารายสัปดาห์')
  })

  it('lists both windows, fullest first', () => {
    expect(estimateLine({ ...base, pct: { weekly: 18.2, five_hour: 45.5 } })).toBe(
      'ใช้ประมาณ 46% ของโควตารอบ 5 ชั่วโมง · 18% ของโควตารายสัปดาห์'
    )
  })

  it('rounds a tiny run to "under 1%"', () => {
    expect(estimateLine({ ...base, pct: { monthly: 0.3 } })).toBe('ใช้ไม่ถึง 1% ของโควตารายเดือน')
  })

  it('has nothing to say for an unlimited account', () => {
    expect(estimateLine({ ...base, unlimited: true, pct: {} })).toBeNull()
  })

  it('warns — never blocks — when the run may go past what is left', () => {
    expect(estimateBlockLine(base, NOW)).toBeNull()
    const none = { ...base, fits: 'none' as const, resets_at: '2026-09-22T11:00:00Z' }
    // Owner, 2026-10-01: it starts, pauses at 100 % and the overage carries.
    expect(estimateBlockLine(none, NOW)).toBe('งานนี้อาจใช้เกินโควตา ส่วนที่เกินจะนับรวมในรอบถัดไป')
    const wallet = { ...base, fits: 'wallet' as const, wallet_satang: 1234 }
    expect(estimateBlockLine(wallet, NOW)).toBe(
      'งานนี้อาจใช้เกินโควตา ส่วนที่เกินจะนับรวมในรอบถัดไป — หรือใช้ยอดเงินคงเหลือ ฿12.34 จ่ายส่วนที่เกินแทน'
    )
    const full = { ...none, full: true }
    expect(estimateBlockLine(full, NOW)).toBe(
      'โควตารอบนี้ใช้ครบแล้ว — เริ่มงานใหม่ได้เมื่อรอบใหม่เริ่ม (รอบใหม่อีก 1 ชม.)'
    )
    expect(estimateBlockLine({ ...none, overage_too_large: true }, NOW)).toBe(
      OVERAGE_TOO_LARGE_LINE
    )
  })

  it('shows a meter past 100 % as an overage that carries', () => {
    const w = { key: 'monthly' as const, used_pct: 106, resets_at: null, active: true }
    expect(windowLine(w, NOW)).toBe('ใช้เกินโควตา 6% · จะนับรวมในรอบถัดไป')
    expect(overageLine({ used_pct: 112, resets: false })).toBe(
      'ใช้เกินเครดิตทดลอง 12% · จะนับรวมเมื่อสมัครแพลน'
    )
  })

  it('never carries a token count', () => {
    const text = [estimateLine(base), estimateBlockLine({ ...base, fits: 'none' }, NOW)].join(' ')
    expect(text).not.toMatch(/token/i)
  })
})

describe('refusals', () => {
  const body402 = {
    detail: {
      code: 'limit_reached',
      window: 'five_hour',
      label: '5-hour limit',
      resets_at: '2026-09-22T11:48:00Z',
      wallet_can_cover: true,
      wallet_satang: 1500,
      message: 'ใช้งานครบ 5-hour limit แล้ว'
    }
  }

  it('parses the 402 body', () => {
    expect(parseRefusal(body402)).toEqual({
      code: 'limit_reached',
      window: 'five_hour',
      resetsAt: '2026-09-22T11:48:00Z',
      resets: true,
      walletCanCover: true,
      walletSatang: 1500,
      serverMessage: 'ใช้งานครบ 5-hour limit แล้ว'
    })
  })

  it('ignores every other error body', () => {
    expect(parseRefusal({ detail: 'ไม่พบโปรเจกต์' })).toBeNull()
    expect(parseRefusal({ detail: [{ loc: ['body'], msg: 'x' }] })).toBeNull()
    expect(parseRefusal({ detail: { code: 'something_else' } })).toBeNull()
    expect(parseRefusal(null)).toBeNull()
  })

  it('writes limit_reached with the local reset time and the wallet hint', () => {
    const r = parseRefusal(body402)!
    expect(refusalMessage(r, NOW)).toBe(
      'โควตารอบ 5 ชั่วโมงหมดแล้ว · เริ่มงานใหม่ได้อีก 1 ชม. 48 นาที — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้'
    )
    expect(refusalMessage({ ...r, walletCanCover: false, resetsAt: null }, NOW)).toBe(
      'โควตารอบ 5 ชั่วโมงหมดแล้ว'
    )
  })

  it('uses the server sentence for the codes it words itself', () => {
    const paused = parseRefusal({ detail: { code: 'service_paused', message: 'หยุดชั่วคราว' } })!
    expect(refusalMessage(paused)).toBe('หยุดชั่วคราว')
    const free = parseRefusal({ detail: { code: 'free_tier_limited' } })!
    expect(refusalMessage(free)).toMatch(/แผนฟรี/)
  })

  it('reads job rows', () => {
    expect(isWaitingSlot({ step: 'waiting_slot', message: 'รอคิว' })).toBe(true)
    expect(isWaitingSlot({ step: 'analyze' })).toBe(false)
    expect(isWaitingSlot(null)).toBe(false)
    expect(jobStopRefusal({ step: 'stopped', code: 'limit_stop', message: 'หยุด' })?.code).toBe(
      'limit_stop'
    )
    expect(jobStopRefusal({ step: 'stopped', code: 'service_paused' })?.code).toBe('service_paused')
    expect(jobStopRefusal({ step: 'stopped' })?.code).toBe('limit_stop')
    expect(jobStopRefusal({ step: 'analyze' })).toBeNull()
  })

  it('words a run paused on the spent trial credit as an upgrade, not a stop', () => {
    // Exactly what the worker writes for run c3c2e938's pause (Free, lifetime).
    const r = jobStopRefusal({
      step: 'stopped',
      paused: true,
      code: 'limit_reached',
      window: 'lifetime',
      label: 'Trial credit',
      resets_at: null,
      resets: false,
      wallet_can_cover: false,
      wallet_satang: 0,
      message: 'พักงานไว้ก่อน: เครดิตทดลองใช้หมดแล้ว'
    })!
    expect(r.code).toBe('limit_reached')
    expect(refusalMessage(r, NOW)).toBe('เครดิตทดลองใช้หมดแล้ว · เปลี่ยนแผนเพื่อใช้ต่อ')
    expect(refusalMessage(r, NOW)).not.toMatch(/หยุดแล้ว|ลองใหม่/)
  })

  it('reads the too-much-overage refusal and keeps the server sentence', () => {
    const r = parseRefusal({
      detail: { code: 'overage_too_large', window: 'monthly', message: 'งานนี้ใหญ่กว่า…' }
    })!
    expect(r.code).toBe('overage_too_large')
    expect(refusalMessage(r, NOW)).toBe('งานนี้ใหญ่กว่า…')
    expect(refusalMessage({ ...r, serverMessage: null }, NOW)).toContain('Scout')
  })
})

describe('queue notice', () => {
  it('names the next job by its place', () => {
    expect(queueNotice(2)).toBe('ทำพร้อมกันได้ 2 งาน งานที่สามจะเริ่มเองเมื่อมีช่องว่าง')
    expect(queueNotice(1)).toMatch(/ครั้งละ 1 งาน/)
  })
})

describe('device id', () => {
  it('is made once and then reused', () => {
    const map = new Map<string, string>()
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v)
    }
    const first = deviceId(store)
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(deviceId(store)).toBe(first)
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined
    }
    const a = deviceId(broken)
    expect(a).toBe(deviceId(broken))
  })
})

describe('a monthly window that has not been used yet', () => {
  // The billing-anniversary change (packages/billing/runs.py): a paid account
  // that has cut nothing this month reads as inactive and still has a real
  // next reset. Before this, windowLine dropped the date on !active and said
  // "เริ่มนับรอบใหม่เมื่อใช้งานครั้งถัดไป" — true of a rolling window, false now.
  const now = new Date('2026-10-01T00:00:00Z')
  const untouched = {
    key: 'monthly' as const,
    used_pct: 0,
    resets_at: '2026-10-15T00:00:00Z',
    active: false
  }

  it('states the date the server sent instead of "at your next use"', () => {
    const line = windowLine(untouched, now)
    expect(line).not.toContain('ครั้งถัดไป')
    expect(line.length).toBeGreaterThan(0)
  })

  it('reads the same whether or not the window has been charged', () => {
    expect(windowLine({ ...untouched, active: true, used_pct: 40 }, now)).toBe(
      windowLine(untouched, now)
    )
  })
})
