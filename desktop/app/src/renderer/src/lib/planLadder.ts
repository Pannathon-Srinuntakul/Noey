/**
 * The plan list, the plan-change dialog copy and the one-line limit notices of
 * docs/design/editor-limits.md (§2, §4, §5, §6). Pure and self-contained (no
 * import from `api.ts`; `qualityTiers.ts` is pure copy and is the one place the
 * quality dials' words live): the desktop keeps a byte-identical copy at
 * `desktop/app/src/renderer/src/lib`.
 *
 * The plan facts mirror the pricing page (noey-frontend/src/lib/plans.ts, the
 * source of truth) and the backend's `packages/billing/limits.py`. Prices are
 * NOT here — they come from `GET /billing/plans`.
 */

import { precisionLevelName } from './qualityTiers'

export const PLAN_ORDER = ['free', 'lite', 'starter', 'pro', 'studio', 'agency', 'max'] as const
export type PlanKey = (typeof PLAN_ORDER)[number]

/**
 * What the Free plan actually is (owner, 2026-09-29): a trial credit spent
 * once, NOT a monthly allowance. Nothing in the editor may describe it as a
 * recurring cycle, because it never comes back.
 */
export const FREE_TRIAL_NOTE = 'แผนฟรีเป็นเครดิตทดลองใช้ครั้งเดียว ไม่รีเซ็ตรายเดือน'

/**
 * Roughly how many cuts a month each plan buys — a MARKETING CLAIM, and only
 * that.
 *
 * It is not a quota and nothing counts down from it. The quota is the
 * percentage the meters show (`usageLimits.meterCopy`), because a cut's cost
 * varies more than fourfold with its length and quality: a countable figure
 * would drop by four on one upload and read as broken. Named `APPROX` so
 * nobody later wires it to a meter — and `usageLimits.ts` deliberately has no
 * access to it.
 *
 * `GET /usage/me` sends the same figure as `features.approx_cuts`, with the
 * same rule attached. Free's is the whole one-time credit, not a monthly one.
 *
 * Never shown without `APPROX_CUTS_NOTE`.
 */
export const PLAN_APPROX_CUTS: Record<PlanKey, number> = {
  free: 2,
  lite: 4,
  starter: 10,
  pro: 30,
  studio: 64,
  agency: 140,
  max: 259
}

/**
 * The same count at ระดับละเอียด, for the plans that may pick it (Pro and up;
 * `features.approx_cuts_high` on `GET /usage/me`). Both maps are HONEST
 * (owner, 2026-10-01): the plan's monthly budget ÷ what a 5-minute raw clip
 * costs under the fitted production model — 185,070 at ระดับปกติ, 267,420 at
 * ระดับละเอียด — ROUNDED DOWN. The backend derives the same figures
 * (`limits.plan_cuts` / `plan_cuts_high`) and the website states them.
 */
export const PLAN_APPROX_HIGH_CUTS: Partial<Record<PlanKey, number>> = {
  pro: 20,
  studio: 44,
  agency: 97,
  max: 179
}

/** What the advertised cut count is counted from, and the fact that it is not
 * a quota. Without both, the count is a promise we break on the first
 * 20-minute clip. */
export const APPROX_CUTS_NOTE = `คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที ปัดลง · คลิปที่ยาวกว่าหรือ${precisionLevelName('high')}ใช้โควตามากกว่า · ไม่ใช่โควตา ระบบไม่ได้นับถอยหลังจากจำนวนนี้`

/** The footage figure in each row is a ตัดฉากเด่น cap (owner, 2026-10-01). The
 * two speech modes take two hours on every plan — packages/billing/limits.py
 * `SPEECH_FOOTAGE_SEC`, `capSecFor` in lib/wizardState.ts — and only a run
 * bigger than the plan's whole window is refused. */
export const FOOTAGE_NOTE =
  'ฟุตเทจในตารางคือเพดานของโหมดตัดฉากเด่น · ตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาวรับได้ถึง 2 ชั่วโมงทุกแผน ถ้าโควตาของแผนพอสำหรับงานนั้น'

/** A plan's advertised cut count; null for an admin-set or unknown plan,
 * which advertises none and must therefore show none. */
export function planApproxCuts(plan: string | null | undefined): number | null {
  const n = PLAN_APPROX_CUTS[(plan ?? '') as PlanKey]
  return n > 0 ? n : null
}

/** The ระดับละเอียด count; null below Pro and for an admin-set or unknown plan. */
export function planApproxHighCuts(plan: string | null | undefined): number | null {
  const n = PLAN_APPROX_HIGH_CUTS[(plan ?? '') as PlanKey]
  return n && n > 0 ? n : null
}

/** "ตัดได้ราว 30 คลิป/เดือน · ระดับละเอียดราว 20 คลิป" — both counts where the
 * plan has both, the ordinary one alone otherwise. Paid plans only. */
function cutsText(plan: PlanKey): string {
  const high = PLAN_APPROX_HIGH_CUTS[plan]
  const main = `ตัดได้ราว ${PLAN_APPROX_CUTS[plan]} คลิป/เดือน`
  return high ? `${main} · ${precisionLevelName('high')}ราว ${high} คลิป` : main
}

/**
 * Design §5 rows: name and the one-line summary under it — the approximate
 * cut count first, then the footage cap per project, then the quality tier
 * the plan may pick. From Pro up the ระดับละเอียด count stands in for that
 * last item: it names the finer setting AND says what it buys (owner,
 * 2026-10-01).
 *
 * "ราว" is load-bearing: the count is a claim about a typical clip, not an
 * allowance. Its basis is `APPROX_CUTS_NOTE`, printed once under the table
 * rather than seven times inside it, and the figures are pinned against
 * `PLAN_APPROX_CUTS` by a test so copy and number cannot drift apart.
 */
export const PLAN_ROWS: { key: PlanKey; name: string; sub: string }[] = [
  {
    key: 'free',
    name: 'ฟรี',
    sub: `ราว ${PLAN_APPROX_CUTS.free} คลิป · ทดลองใช้ครั้งเดียว ไม่รีเซ็ต · ฟุตเทจ 10 นาที · ${precisionLevelName('standard')}`
  },
  {
    key: 'lite',
    name: 'Lite',
    sub: `${cutsText('lite')} · ฟุตเทจ 10 นาที · ${precisionLevelName('standard')}`
  },
  {
    key: 'starter',
    name: 'Starter',
    sub: `${cutsText('starter')} · ฟุตเทจ 20 นาที · ${precisionLevelName('standard')}`
  },
  { key: 'pro', name: 'Pro', sub: `${cutsText('pro')} · ฟุตเทจ 30 นาที` },
  { key: 'studio', name: 'Studio', sub: `${cutsText('studio')} · ฟุตเทจ 30 นาที` },
  { key: 'agency', name: 'Agency', sub: `${cutsText('agency')} · ฟุตเทจ 30 นาที` },
  { key: 'max', name: 'Max', sub: `${cutsText('max')} · ฟุตเทจ 30 นาที` }
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

// ── beta pricing (owner, 2026-09-29) ─────────────────────────────────────────

/**
 * The 50% beta discount ends at the last instant of 31 Dec 2026, Bangkok time
 * (UTC+7). It is a HARD stop for everyone, existing subscribers included:
 * from the first billing cycle of 2027 every subscription is charged the full
 * price. There are no coupon codes — the discounted number goes to the
 * payment provider directly and the full price is struck-through text only.
 *
 * Every sentence, badge and struck-through price about the discount hangs off
 * THIS constant. Once the date passes they all disappear on their own and the
 * plain wording — true again by then — comes back, with no deploy.
 */
export const BETA_PRICE_ENDS_AT = '2026-12-31T16:59:59.999Z'
/** How the last discounted day is written to a person. */
export const BETA_PRICE_END_TEXT = '31 ธ.ค. 2026'
/** The first billing cycle charged at the full price. */
export const FULL_PRICE_FROM_TEXT = '1 ม.ค. 2027'

/**
 * The full (undiscounted) monthly price in satang.
 *
 * `GET /billing/plans` sends the price the card is actually charged, which is
 * the BETA price while the discount runs — so the full price exists nowhere
 * on the wire and lives here, as the struck-through number and as what the
 * next-cycle sentences promise.
 */
export const FULL_PRICE_SATANG: Record<PlanKey, number> = {
  free: 0,
  lite: 19_900,
  starter: 39_900,
  pro: 99_000,
  studio: 199_000,
  agency: 399_000,
  max: 699_000
}

/** True while the beta discount is still in force. */
export function betaPricing(now: Date = new Date()): boolean {
  return now.getTime() <= Date.parse(BETA_PRICE_ENDS_AT)
}

/**
 * The full price a plan returns to, or null when there is nothing to say —
 * the beta is over, the plan is free, or the plan is not one of ours.
 */
export function fullPriceAfterBeta(
  tier: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!betaPricing(now)) return null
  const full = FULL_PRICE_SATANG[(tier ?? '') as PlanKey]
  return full > 0 ? full : null
}

export const BETA_BADGE = 'เบต้า'
export const BETA_STRIP_TEXT = `ราคาเบต้า ลด 50% ถึง ${BETA_PRICE_END_TEXT} · หลังจากนั้นทุกบัญชีคิดราคาปกติในรอบบิลถัดไป`

export const PLAN_FOOTER = 'เปลี่ยนขึ้นมีผลทันที เปลี่ยนลงมีผลรอบบิลถัดไป'

/** The footnote under the plan table; carries the beta end date while it runs. */
export function planFooter(now: Date = new Date()): string {
  return betaPricing(now) ? `${PLAN_FOOTER} · ราคาเบต้าสิ้นสุด ${BETA_PRICE_END_TEXT}` : PLAN_FOOTER
}

export const PLAN_CONSENT =
  'ฉันเข้าใจว่าระบบจะตัดบัตรทุกเดือนจนกว่าจะยกเลิก และรอบที่ใช้ไปแล้วไม่คืนเงิน'

/**
 * What the user actually ticks. A price rise that is already decided is part
 * of the agreement, not a footnote: while the beta runs the clause names the
 * full price and the date it starts. After 31 Dec 2026 the sentence is the
 * original one again.
 */
export function planConsentText(tier: string | null | undefined, now: Date = new Date()): string {
  const full = fullPriceAfterBeta(tier, now)
  if (full === null) return PLAN_CONSENT
  return `${PLAN_CONSENT} และฉันรับทราบว่าราคานี้เป็นราคาเบต้าถึง ${BETA_PRICE_END_TEXT} · รอบบิลตั้งแต่ ${FULL_PRICE_FROM_TEXT} จะตัดบัตร ${priceText(full)} ตามราคาปกติ`
}

/**
 * The highlighted callout in the plan-change dialog: this cycle's price, the
 * day it stops being the price, and the number that replaces it. Null once
 * the beta is over — there is then nothing to warn about.
 */
export function betaPriceCallout(
  tier: string | null | undefined,
  currentPriceSatang: number,
  now: Date = new Date()
): string | null {
  const full = fullPriceAfterBeta(tier, now)
  if (full === null) return null
  return `${priceText(currentPriceSatang)} คือราคาเบต้า ถึง ${BETA_PRICE_END_TEXT} / รอบบิลตั้งแต่ ${FULL_PRICE_FROM_TEXT} เป็นต้นไป ตัดบัตร ${priceText(full)} ตามราคาปกติ ยกเลิกได้ทุกเมื่อก่อนถึงวันนั้น`
}

// ── quality tiers ────────────────────────────────────────────────────────────

/** The cheapest plan allowed to pick the high quality tier (owner,
 * 2026-09-29, revised: Free, Lite AND Starter cannot). */
export const HIGH_PRECISION_MIN_PLAN = 'pro'

/** True when this plan may not choose the high quality tier. An unknown or
 * admin-set plan is never locked — the server is the one that refuses. */
export function highPrecisionLocked(plan: string | null | undefined): boolean {
  const rank = planRank(plan)
  return rank >= 0 && rank < planRank(HIGH_PRECISION_MIN_PLAN)
}

function dateTh(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return 'รอบบิลถัดไป'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'รอบบิลถัดไป'
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone }).format(d)
}

/**
 * The confirm dialog body (design §6), from `POST /billing/plan-preview`.
 *
 * While the beta discount runs, every sentence that promises a monthly price
 * says WHICH price until WHEN and what replaces it — as numbers and a date.
 * "ตัดทุกเดือนในราคาเดียวกัน" stops being true on 1 Jan 2027, and a sentence
 * that is false on a known date must not be the one the user agrees to.
 */
export function planChangeBody(
  p: {
    tier: string
    direction: 'upgrade' | 'downgrade' | 'same'
    due_now_satang: number
    next_price_satang: number
    effective_at: string | null
  },
  timeZone?: string,
  now: Date = new Date()
): string {
  const full = fullPriceAfterBeta(p.tier, now)
  /** "ถึง 31 ธ.ค. 2026 · ตั้งแต่ 1 ม.ค. 2027 ตัดบัตร ฿990 ตามราคาปกติ" */
  const afterBeta =
    full === null
      ? ''
      : ` ถึง ${BETA_PRICE_END_TEXT} · รอบบิลตั้งแต่ ${FULL_PRICE_FROM_TEXT} ตัดบัตร ${priceText(full)} ตามราคาปกติ`

  if (p.direction === 'upgrade') {
    // A first subscription (from Free) pays the full price now — "ตามวันที่เหลือ
    // ของรอบบิล" is only true when an existing paid period is being prorated.
    if (p.due_now_satang > 0 && p.due_now_satang >= p.next_price_satang) {
      const monthly =
        full === null
          ? 'แล้วตัดทุกเดือนในราคาเดียวกัน'
          : `แล้วตัดเดือนละ ${priceText(p.next_price_satang)}${afterBeta}`
      return `โควตาใหม่มีผลทันทีหลังชำระเงิน ครั้งนี้ตัดบัตร ${priceText(p.due_now_satang)} ${monthly}`
    }
    const head =
      p.due_now_satang > 0
        ? `ครั้งนี้ตัดบัตร ${priceText(p.due_now_satang)} ตามวันที่เหลือของรอบบิล `
        : ''
    return `โควตาใหม่มีผลทันทีหลังชำระเงิน ${head}เดือนถัดไป ${priceText(p.next_price_satang)}${afterBeta}`
  }
  if (p.tier === 'free') {
    const until = p.effective_at ? `วันที่ ${dateTh(p.effective_at, timeZone)}` : 'สิ้นรอบบิล'
    return `ใช้แผนปัจจุบันได้ถึง${until} จากนั้นกลับเป็นแผนฟรี ไม่ตัดบัตรอีก · ${FREE_TRIAL_NOTE}`
  }
  return `มีผลรอบบิลถัดไป (${dateTh(p.effective_at, timeZone)}) ไม่ตัดบัตรตอนนี้ เดือนถัดไป ${priceText(p.next_price_satang)}${afterBeta}`
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
export function featureLockedLine(
  feature: 'music' | 'transcode' | 'precision',
  minPlan: string
): string {
  const what =
    feature === 'music'
      ? 'เพลงประกอบ'
      : feature === 'precision'
        ? precisionLevelName('high')
        : 'การแปลงไฟล์ที่เบราว์เซอร์เปิดไม่ได้'
  return `${what}ใช้ได้ตั้งแต่แผน ${planLabel(minPlan)} ขึ้นไป`
}

// ── near-limit banner (design §2) ────────────────────────────────────────────

export const BANNER_THRESHOLD = 80

export interface BannerLimit {
  key: 'five_hour' | 'weekly' | 'monthly' | 'lifetime'
  used_pct: number
  resets_at: string | null
  active: boolean
  /** False = the allowance never comes back (the Free trial credit). Absent
   * on an older server, which only ever sent windows that do reset. */
  resets?: boolean
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
