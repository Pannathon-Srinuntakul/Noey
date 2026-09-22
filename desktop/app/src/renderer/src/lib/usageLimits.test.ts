import { describe, expect, it } from 'vitest'
import {
  checkoutAlreadyCredited,
  deviceId,
  durationTh,
  estimateBlockLine,
  estimateLine,
  formatBaht,
  formatPack,
  isWaitingSlot,
  LEDGER_LABELS,
  jobStopRefusal,
  limitLabel,
  orderedMethods,
  parseRefusal,
  pctText,
  planName,
  queueNotice,
  refusalMessage,
  resetLine,
  shortDate,
  storageText,
  usageTone,
  whenBack,
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

  it('explains a block and the wallet way out', () => {
    expect(estimateBlockLine(base, NOW)).toBeNull()
    const none = { ...base, fits: 'none' as const, resets_at: '2026-09-22T11:00:00Z' }
    expect(estimateBlockLine(none, NOW)).toBe(
      'โควตารายสัปดาห์เหลือไม่พอสำหรับงานนี้ · รอบใหม่อีก 1 ชม.'
    )
    const wallet = { ...base, fits: 'wallet' as const, wallet_satang: 1234 }
    expect(estimateBlockLine(wallet, NOW)).toBe(
      'โควตารายสัปดาห์เหลือไม่พอสำหรับงานนี้ — ใช้ยอดเงินคงเหลือ ฿12.34 ทำต่อได้'
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
