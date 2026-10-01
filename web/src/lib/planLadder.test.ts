import { describe, expect, it } from 'vitest'
import {
  bannerKey,
  type BannerLimit,
  BETA_PRICE_ENDS_AT,
  betaPriceCallout,
  betaPricing,
  canChangePlan,
  featureLockedLine,
  footageNotice,
  FULL_PRICE_SATANG,
  FOOTAGE_NOTE,
  fullPriceAfterBeta,
  HIGH_PRECISION_MIN_PLAN,
  highPrecisionLocked,
  nearLimit,
  PLAN_CONSENT,
  PLAN_FOOTER,
  PLAN_ROWS,
  planButtonLabel,
  planChangeBody,
  planConsentText,
  planFooter,
  priceText,
  projectLimitNotice,
  queueLimitNotice,
  QUOTA_NOTE,
  storageNotice
} from './planLadder'

/** Inside the beta window, and the first day after it. */
const BETA = new Date('2026-09-29T00:00:00Z')
const AFTER_BETA = new Date(Date.parse(BETA_PRICE_ENDS_AT) + 1)

describe('plan list (design §5)', () => {
  it('lists the seven plans of the pricing page in order', () => {
    expect(PLAN_ROWS.map((r) => r.key)).toEqual([
      'free',
      'lite',
      'starter',
      'pro',
      'studio',
      'agency',
      'max'
    ])
    expect(PLAN_ROWS[3].sub).toBe(
      'ฟุตเทจ 30 นาที · เลือกระดับละเอียดได้ · ทำงานพร้อมกัน 2 งาน · 10 GB'
    )
    expect(PLAN_ROWS[2].sub).toBe('ฟุตเทจ 20 นาที · ระดับปกติ · 5 GB')
  })

  it('labels the row button by direction', () => {
    expect(planButtonLabel('pro', 'studio')).toBe('เปลี่ยนเป็นแผนนี้')
    expect(planButtonLabel('pro', 'lite')).toBe('ลดมาแผนนี้')
    expect(planButtonLabel('pro', 'pro')).toBeNull()
  })

  it('does not offer changes on an admin-set plan', () => {
    expect(canChangePlan('enterprise')).toBe(false)
    expect(canChangePlan('free')).toBe(true)
  })

  it('writes whole-baht prices', () => {
    expect(priceText(199_000)).toBe('฿1,990')
    expect(priceText(0)).toBe('฿0')
  })

  it('describes Free as a credit spent once, not a monthly allowance', () => {
    expect(PLAN_ROWS[0].sub).toContain('ครั้งเดียว')
    expect(PLAN_ROWS[0].sub).not.toContain('เดือน')
  })

  it('carries the footage cap each plan actually gives', () => {
    expect(PLAN_ROWS[0].sub).toContain('10 นาที')
    expect(PLAN_ROWS[1].sub).toContain('10 นาที')
    expect(PLAN_ROWS[2].sub).toContain('20 นาที')
    expect(PLAN_ROWS[3].sub).toContain('30 นาที')
  })

  it('states no clip count, and which tier each plan may pick', () => {
    // Owner, 2026-10-01: a count is pinned to one mode and raw-clip length,
    // so it lives on the website's pricing calculator only.
    for (const row of PLAN_ROWS) expect(row.sub, row.key).not.toMatch(/คลิป|ราว/)
    // The three cheapest plans are Standard-only (owner, 2026-09-29 revision).
    expect(PLAN_ROWS.slice(0, 3).every((r) => r.sub.includes('ระดับปกติ'))).toBe(true)
    expect(PLAN_ROWS.slice(0, 3).some((r) => r.sub.includes('ระดับละเอียด'))).toBe(false)
    expect(PLAN_ROWS.slice(3).every((r) => r.sub.includes('เลือกระดับละเอียดได้'))).toBe(true)
  })

  it('says what a clip count depends on and where to find it, and what the footage means', () => {
    expect(QUOTA_NOTE).toContain('โหมด')
    expect(QUOTA_NOTE).toContain('ความยาวคลิปดิบ')
    expect(QUOTA_NOTE).toContain('หน้าราคา')
    expect(QUOTA_NOTE).not.toMatch(/\d+ คลิป/)
    expect(FOOTAGE_NOTE).toContain('ตัดฉากเด่น')
    expect(FOOTAGE_NOTE).toContain('2 ชั่วโมง')
  })
})

describe('beta pricing (owner, 2026-09-29)', () => {
  it('runs to the last instant of 31 Dec 2026 Bangkok time and not past it', () => {
    expect(betaPricing(BETA)).toBe(true)
    expect(betaPricing(new Date(Date.parse(BETA_PRICE_ENDS_AT)))).toBe(true)
    expect(betaPricing(AFTER_BETA)).toBe(false)
  })

  it('halves every paid plan — the full price is the struck-through one', () => {
    expect(FULL_PRICE_SATANG.pro).toBe(99_000)
    expect(fullPriceAfterBeta('pro', BETA)).toBe(99_000)
    // Free has no price to strike through, and neither has an admin-set plan.
    expect(fullPriceAfterBeta('free', BETA)).toBeNull()
    expect(fullPriceAfterBeta('enterprise', BETA)).toBeNull()
  })

  it('says nothing at all once the date has passed', () => {
    expect(fullPriceAfterBeta('pro', AFTER_BETA)).toBeNull()
    expect(betaPriceCallout('pro', 49_900, AFTER_BETA)).toBeNull()
    expect(planConsentText('pro', AFTER_BETA)).toBe(PLAN_CONSENT)
    expect(planFooter(AFTER_BETA)).toBe(PLAN_FOOTER)
  })

  it('states both prices and both dates as numbers in the callout', () => {
    expect(betaPriceCallout('pro', 49_900, BETA)).toBe(
      '฿499 คือราคาเบต้า ถึง 31 ธ.ค. 2026 / รอบบิลตั้งแต่ 1 ม.ค. 2027 เป็นต้นไป ตัดบัตร ฿990 ตามราคาปกติ ยกเลิกได้ทุกเมื่อก่อนถึงวันนั้น'
    )
  })

  it('puts the rise inside what the user ticks', () => {
    const consent = planConsentText('pro', BETA)
    expect(consent.startsWith(PLAN_CONSENT)).toBe(true)
    expect(consent).toContain('1 ม.ค. 2027')
    expect(consent).toContain('฿990')
    // Moving to Free is not a subscription, so nothing is added to it.
    expect(planConsentText('free', BETA)).toBe(PLAN_CONSENT)
  })

  it('dates the footnote under the plan table', () => {
    expect(planFooter(BETA)).toBe(`${PLAN_FOOTER} · ราคาเบต้าสิ้นสุด 31 ธ.ค. 2026`)
  })
})

describe('the High precision tier', () => {
  it('is closed to Free, Lite AND Starter', () => {
    expect(HIGH_PRECISION_MIN_PLAN).toBe('pro')
    expect(highPrecisionLocked('free')).toBe(true)
    expect(highPrecisionLocked('lite')).toBe(true)
    expect(highPrecisionLocked('starter')).toBe(true)
    expect(highPrecisionLocked(HIGH_PRECISION_MIN_PLAN)).toBe(false)
    expect(highPrecisionLocked('max')).toBe(false)
    // An admin-set plan is the server's business, not this table's.
    expect(highPrecisionLocked('enterprise')).toBe(false)
  })

  it('names the cheapest plan that has it', () => {
    expect(featureLockedLine('precision', HIGH_PRECISION_MIN_PLAN)).toBe(
      'ระดับละเอียดใช้ได้ตั้งแต่แผน Pro ขึ้นไป'
    )
  })
})

describe('confirm dialog body (design §6)', () => {
  it('states the prorated charge now and the next month', () => {
    expect(
      planChangeBody(
        {
          tier: 'pro',
          direction: 'upgrade',
          due_now_satang: 70_300,
          next_price_satang: 99_000,
          effective_at: null
        },
        undefined,
        AFTER_BETA
      )
    ).toBe(
      'โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿703 ตามวันที่เหลือของรอบบิล เดือนถัดไป ฿990'
    )
  })

  it('charges a first subscription in full, without the proration wording', () => {
    expect(
      planChangeBody(
        {
          tier: 'pro',
          direction: 'upgrade',
          due_now_satang: 99_000,
          next_price_satang: 99_000,
          effective_at: null
        },
        undefined,
        AFTER_BETA
      )
    ).toBe('โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿990 แล้วตัดทุกเดือนในราคาเดียวกัน')
  })

  it('never says "the same price every month" while a rise is already dated', () => {
    const body = planChangeBody(
      {
        tier: 'pro',
        direction: 'upgrade',
        due_now_satang: 49_900,
        next_price_satang: 49_900,
        effective_at: null
      },
      undefined,
      BETA
    )
    expect(body).toBe(
      'โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿499 แล้วตัดเดือนละ ฿499 ถึง 31 ธ.ค. 2026 · รอบบิลตั้งแต่ 1 ม.ค. 2027 ตัดบัตร ฿990 ตามราคาปกติ'
    )
    expect(body).not.toContain('ราคาเดียวกัน')
  })

  it('carries the same two numbers into a prorated upgrade and a downgrade', () => {
    const up = planChangeBody(
      {
        tier: 'studio',
        direction: 'upgrade',
        due_now_satang: 30_000,
        next_price_satang: 99_900,
        effective_at: null
      },
      undefined,
      BETA
    )
    expect(up).toContain('เดือนถัดไป ฿999 ถึง 31 ธ.ค. 2026')
    expect(up).toContain('ตัดบัตร ฿1,990 ตามราคาปกติ')
    const down = planChangeBody(
      {
        tier: 'lite',
        direction: 'downgrade',
        due_now_satang: 0,
        next_price_satang: 9_900,
        effective_at: '2026-10-10T00:00:00Z'
      },
      'UTC',
      BETA
    )
    expect(down).toContain('เดือนถัดไป ฿99 ถึง 31 ธ.ค. 2026')
    expect(down).toContain('฿199 ตามราคาปกติ')
  })

  it('says a downgrade waits for the next cycle and charges nothing now', () => {
    const body = planChangeBody(
      {
        tier: 'lite',
        direction: 'downgrade',
        due_now_satang: 0,
        next_price_satang: 19_900,
        effective_at: '2026-10-10T00:00:00Z'
      },
      'UTC',
      AFTER_BETA
    )
    expect(body).toContain('มีผลรอบบิลถัดไป')
    expect(body).toContain('ไม่ตัดบัตรตอนนี้')
    expect(body).toContain('฿199')
  })

  it('explains moving to Free as a credit spent once', () => {
    const body = planChangeBody(
      {
        tier: 'free',
        direction: 'downgrade',
        due_now_satang: 0,
        next_price_satang: 0,
        effective_at: null
      },
      undefined,
      BETA
    )
    expect(body).toContain('กลับเป็นแผนฟรี')
    expect(body).toContain('เครดิตทดลองใช้ครั้งเดียว ไม่รีเซ็ตรายเดือน')
  })
})

describe('one-line notices (design §4)', () => {
  it('blocks footage over the plan cap, with the server tolerance', () => {
    expect(footageNotice(1200, 1200)).toBeNull()
    expect(footageNotice(1204, 1200)).toBeNull()
    const n = footageNotice(24 * 60, 20 * 60)
    expect(n?.block).toBe(true)
    expect(n?.text).toBe(
      'ฟุตเทจรวม 24 นาที เกินเพดาน 20 นาทีของแผนนี้ ตัดให้สั้นลงหรือแยกเป็นสองโปรเจกต์'
    )
    expect(footageNotice(99_999, null)).toBeNull()
  })

  it('blocks files that do not fit in the storage left', () => {
    const g = 1024 ** 3
    const n = storageNotice(9.6 * g, 10 * g, 1.4 * g)
    expect(n?.text).toBe('เหลือพื้นที่ 0.4 GB ไม่พอสำหรับไฟล์ชุดนี้ 1.4 GB')
    expect(storageNotice(1 * g, 10 * g, 1.4 * g)).toBeNull()
    expect(storageNotice(99 * g, 0, 1 * g)).toBeNull()
  })

  it('blocks a new project past the plan cap', () => {
    expect(projectLimitNotice(2, 3)).toBeNull()
    expect(projectLimitNotice(3, 3)?.block).toBe(true)
    expect(projectLimitNotice(1, 3, 3)?.block).toBe(true)
    expect(projectLimitNotice(500, null)).toBeNull()
  })

  it('words the queue line like the design', () => {
    expect(queueLimitNotice(2).text).toBe('ทำพร้อมกันได้ 2 งาน งานที่สามจะเริ่มเองเมื่อมีช่องว่าง')
  })

  it('names the cheapest plan for a locked feature', () => {
    expect(featureLockedLine('music', 'lite')).toBe('เพลงประกอบใช้ได้ตั้งแต่แผน Lite ขึ้นไป')
  })
})

describe('near-limit banner (design §2)', () => {
  const w = (key: 'weekly' | 'five_hour', pct: number, active = true): BannerLimit => ({
    key,
    used_pct: pct,
    resets_at: '2026-09-29T09:00:00Z',
    active
  })

  it('picks the fullest active window at 80% or more', () => {
    expect(nearLimit([w('weekly', 54), w('five_hour', 82)])?.key).toBe('five_hour')
    expect(nearLimit([w('weekly', 79)])).toBeNull()
    expect(nearLimit([w('weekly', 95, false)])).toBeNull()
  })

  it('keys a dismissal to the window and its reset', () => {
    expect(bannerKey(w('weekly', 90))).toBe('weekly|2026-09-29T09:00:00Z')
  })
})
