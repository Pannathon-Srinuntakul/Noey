import { describe, expect, it } from 'vitest'
import {
  bannerKey,
  type BannerLimit,
  canChangePlan,
  featureLockedLine,
  footageNotice,
  nearLimit,
  PLAN_ROWS,
  planButtonLabel,
  planChangeBody,
  priceText,
  projectLimitNotice,
  queueLimitNotice,
  storageNotice
} from './planLadder'

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
    expect(PLAN_ROWS[3].sub).toBe('5x · ฟุตเทจ 2 ชม. · 10 GB')
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
})

describe('confirm dialog body (design §6)', () => {
  it('states the prorated charge now and the next month', () => {
    expect(
      planChangeBody({
        tier: 'pro',
        direction: 'upgrade',
        due_now_satang: 70_300,
        next_price_satang: 99_000,
        effective_at: null
      })
    ).toBe(
      'โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿703 ตามวันที่เหลือของรอบบิล เดือนถัดไป ฿990'
    )
  })

  it('charges a first subscription in full, without the proration wording', () => {
    expect(
      planChangeBody({
        tier: 'pro',
        direction: 'upgrade',
        due_now_satang: 99_000,
        next_price_satang: 99_000,
        effective_at: null
      })
    ).toBe('โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ฿990 แล้วตัดทุกเดือนในราคาเดียวกัน')
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
      'UTC'
    )
    expect(body).toContain('มีผลรอบบิลถัดไป')
    expect(body).toContain('ไม่ตัดบัตรตอนนี้')
    expect(body).toContain('฿199')
  })

  it('explains moving to Free', () => {
    expect(
      planChangeBody({
        tier: 'free',
        direction: 'downgrade',
        due_now_satang: 0,
        next_price_satang: 0,
        effective_at: null
      })
    ).toContain('กลับเป็นแผนฟรี')
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
