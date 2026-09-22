/**
 * The plan list, the plan-change dialog copy and the one-line limit notices of
 * docs/design/editor-limits.md (§2, §4, §5, §6). Pure and self-contained (no
 * import from `api.ts`): the desktop keeps a byte-identical copy at
 * `desktop/app/src/renderer/src/lib`.
 *
 * The plan facts mirror the pricing page (noey-frontend/src/lib/plans.ts, the
 * source of truth) and the backend's `packages/billing/limits.py`. Prices are
 * NOT here — they come from `GET /billing/plans`.
 */

export const PLAN_ORDER = ['free', 'lite', 'starter', 'pro', 'studio', 'agency', 'max'] as const
export type PlanKey = (typeof PLAN_ORDER)[number]

/** Design §5 rows: name and the one-line summary under it. */
export const PLAN_ROWS: { key: PlanKey; name: string; sub: string }[] = [
  { key: 'free', name: 'ฟรี', sub: 'ทดลองใช้ · ฟุตเทจ 5 นาที/โปรเจกต์' },
  { key: 'lite', name: 'Lite', sub: '1x · ฟุตเทจ 10 นาที · 3 GB' },
  { key: 'starter', name: 'Starter', sub: '2x · ฟุตเทจ 20 นาที · 5 GB' },
  { key: 'pro', name: 'Pro', sub: '5x · ฟุตเทจ 2 ชม. · 10 GB' },
  { key: 'studio', name: 'Studio', sub: '10x · พร้อมกัน 3 งาน · 30 GB' },
  { key: 'agency', name: 'Agency', sub: '20x · พร้อมกัน 4 งาน · 60 GB' },
  { key: 'max', name: 'Max', sub: '35x · พร้อมกัน 5 งาน · 100 GB' }
]

export function planRank(plan: string | null | undefined): number {
  return PLAN_ORDER.indexOf((plan ?? 'free') as PlanKey)
}

export function planLabel(plan: string | null | undefined): string {
  return PLAN_ROWS.find((r) => r.key === plan)?.name ?? (plan || 'ฟรี')
}

/** "฿990" / "฿1,990" / "฿0" — whole baht, the way the design writes prices. */
export function priceText(satang: number | null | undefined): string {
  const baht = Math.round((satang ?? 0) / 100)
  return `฿${baht.toLocaleString('en-US')}`
}

/** The row button (design §5): higher = "เปลี่ยนเป็นแผนนี้", lower = "ลดมาแผนนี้". */
export function planButtonLabel(current: string, target: string): string | null {
  const a = planRank(current)
  const b = planRank(target)
  if (a === b) return null
  return b > a ? 'เปลี่ยนเป็นแผนนี้' : 'ลดมาแผนนี้'
}

/** Admin-set plans (enterprise) and unknown plans cannot be changed here. */
export function canChangePlan(current: string | null | undefined): boolean {
  return planRank(current) >= 0
}

export const PLAN_FOOTER = 'เปลี่ยนขึ้นมีผลทันที เปลี่ยนลงมีผลรอบบิลถัดไป'
export const PLAN_CONSENT =
  'ฉันเข้าใจว่าระบบจะตัดบัตรทุกเดือนจนกว่าจะยกเลิก และรอบที่ใช้ไปแล้วไม่คืนเงิน'

function dateTh(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return 'รอบบิลถัดไป'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'รอบบิลถัดไป'
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone }).format(d)
}

/** The confirm dialog body (design §6), from `POST /billing/plan-preview`. */
export function planChangeBody(
  p: {
    tier: string
    direction: 'upgrade' | 'downgrade' | 'same'
    due_now_satang: number
    next_price_satang: number
    effective_at: string | null
  },
  timeZone?: string
): string {
  if (p.direction === 'upgrade') {
    // A first subscription (from Free) pays the full price now — "ตามวันที่เหลือ
    // ของรอบบิล" is only true when an existing paid period is being prorated.
    if (p.due_now_satang > 0 && p.due_now_satang >= p.next_price_satang) {
      return `โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ${priceText(p.due_now_satang)} แล้วตัดทุกเดือนในราคาเดียวกัน`
    }
    const now =
      p.due_now_satang > 0
        ? `ครั้งนี้ตัดบัตร ${priceText(p.due_now_satang)} ตามวันที่เหลือของรอบบิล `
        : ''
    return `โควตาใหม่มีผลทันทีหลังชำระเงิน ${now}เดือนถัดไป ${priceText(p.next_price_satang)}`
  }
  if (p.tier === 'free') {
    const until = p.effective_at ? `วันที่ ${dateTh(p.effective_at, timeZone)}` : 'สิ้นรอบบิล'
    return `ใช้แผนปัจจุบันได้ถึง${until} จากนั้นกลับเป็นแผนฟรี ไม่ตัดบัตรอีก`
  }
  return `มีผลรอบบิลถัดไป (${dateTh(p.effective_at, timeZone)}) ไม่ตัดบัตรตอนนี้ เดือนถัดไป ${priceText(p.next_price_satang)}`
}

// ── one-line notices (design §4) ─────────────────────────────────────────────

export interface LimitNotice {
  /** Short label on the left: "ฟุตเทจเกิน", "พื้นที่เต็ม", … */
  when: string
  text: string
  /** Optional action link text. */
  action?: string
  /** Where the action goes. */
  target?: 'files' | 'projects' | 'plans' | 'billing'
  /** True when the start must not go ahead. */
  block: boolean
}

function minutesTh(sec: number): string {
  const m = sec / 60
  if (m >= 60 && m % 60 === 0) return `${m / 60} ชั่วโมง`
  if (m >= 10) return `${Math.round(m)} นาที`
  return `${Math.round(m * 10) / 10} นาที`
}

/** Tolerance the server applies too (packages/billing/plan_features.py). */
export const FOOTAGE_TOLERANCE_SEC = 5

export function footageNotice(
  totalSec: number,
  limitSec: number | null | undefined
): LimitNotice | null {
  if (limitSec == null || !(totalSec > limitSec + FOOTAGE_TOLERANCE_SEC)) return null
  return {
    when: 'ฟุตเทจเกิน',
    text: `ฟุตเทจรวม ${minutesTh(totalSec)} เกินเพดาน ${minutesTh(limitSec)}ของแผนนี้ ตัดให้สั้นลงหรือแยกเป็นสองโปรเจกต์`,
    action: 'ดูไฟล์',
    target: 'files',
    block: true
  }
}

function gb(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
}

export function storageNotice(
  usedBytes: number,
  quotaBytes: number,
  incomingBytes: number
): LimitNotice | null {
  if (quotaBytes <= 0 || incomingBytes <= 0) return null
  const free = Math.max(0, quotaBytes - usedBytes)
  if (incomingBytes <= free) return null
  return {
    when: 'พื้นที่เต็ม',
    text: `เหลือพื้นที่ ${gb(free)} ไม่พอสำหรับไฟล์ชุดนี้ ${gb(incomingBytes)}`,
    action: 'ลบงานเก่า',
    target: 'projects',
    block: true
  }
}

export function projectLimitNotice(
  count: number,
  max: number | null | undefined,
  adding = 1
): LimitNotice | null {
  if (max == null || count + Math.max(1, adding) <= max) return null
  return {
    when: 'โปรเจกต์เต็ม',
    text: `แผนนี้เก็บโปรเจกต์ได้ ${max} โปรเจกต์ ลบโปรเจกต์เก่าหรือเปลี่ยนแผนเพื่อสร้างใหม่ โปรเจกต์เดิมยังเปิดและแก้ได้ตามปกติ`,
    action: 'ลบงานเก่า',
    target: 'projects',
    block: true
  }
}

const THAI_ORDINAL: Record<number, string> = { 2: 'สอง', 3: 'สาม', 4: 'สี่', 5: 'ห้า', 6: 'หก' }

export function queueLimitNotice(max: number): LimitNotice {
  const next = THAI_ORDINAL[max + 1] ?? String(max + 1)
  return {
    when: 'คิวงาน',
    text: `ทำพร้อมกันได้ ${max} งาน งานที่${next}จะเริ่มเองเมื่อมีช่องว่าง`,
    block: false
  }
}

export function paymentFailedNotice(graceUntil: string, timeZone?: string): LimitNotice {
  return {
    when: 'เก็บเงินไม่ได้',
    text: `ตัดบัตรไม่สำเร็จ ถ้ายังไม่สำเร็จจะกลับเป็นแผนฟรีวันที่ ${dateTh(graceUntil, timeZone)}`,
    action: 'แก้ข้อมูลบัตร',
    target: 'billing',
    block: false
  }
}

/** "เพลงประกอบใช้ได้ตั้งแต่แผน Lite ขึ้นไป" — the locked music control. */
export function featureLockedLine(feature: 'music' | 'transcode', minPlan: string): string {
  const what = feature === 'music' ? 'เพลงประกอบ' : 'การแปลงไฟล์ที่เบราว์เซอร์เปิดไม่ได้'
  return `${what}ใช้ได้ตั้งแต่แผน ${planLabel(minPlan)} ขึ้นไป`
}

// ── near-limit banner (design §2) ────────────────────────────────────────────

export const BANNER_THRESHOLD = 80

export interface BannerLimit {
  key: 'five_hour' | 'weekly' | 'monthly'
  used_pct: number
  resets_at: string | null
  active: boolean
}

/** The fullest ACTIVE quota window at or past 80%, else null. */
export function nearLimit<T extends BannerLimit>(
  limits: readonly T[] | null | undefined
): T | null {
  const hot = (limits ?? []).filter((l) => l.active && l.used_pct >= BANNER_THRESHOLD)
  if (!hot.length) return null
  return hot.reduce((a, b) => (b.used_pct > a.used_pct ? b : a))
}

/** A dismissal lasts for one window + reset: the next window warns again. */
export function bannerKey(l: BannerLimit): string {
  return `${l.key}|${l.resets_at ?? ''}`
}
