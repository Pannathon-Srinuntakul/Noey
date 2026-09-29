/**
 * Plan limits as the user sees them — percentages, reset times and a baht
 * balance. Never a token count: the server does not send one, and nothing
 * here may turn a percentage back into one.
 *
 * Pure and self-contained on purpose (no import from `api.ts`): the desktop
 * keeps a byte-identical copy at `desktop/app/src/renderer/src/lib`, whose
 * partial tree cannot load `api.ts` in a test.
 *
 * Contracts: docs/token-billing-design.md §19. Copy: docs/design/editor-limits.md
 * (owner, 2026-09-22) — the editor names the windows in Thai; the English
 * `label` the API also sends is for the marketing site's pricing copy.
 *
 * Every time arrives as UTC ISO and is formatted here with the VIEWER's own
 * timezone (`Intl` with no `timeZone`). The optional `timeZone` arguments
 * exist for tests only.
 */

// ── shapes (docs/token-billing-design.md §19) ────────────────────────────────

/** `lifetime` is the Free plan's one-time credit: a window that never ends,
 * and therefore never resets (`resets: false` rides with it). */
export type LimitKey = 'five_hour' | 'weekly' | 'monthly' | 'lifetime'

export interface UsageLimit {
  key: LimitKey
  /** English pricing-page label ("Weekly limit"); the editor shows `limitLabel(key)`. */
  label: string
  /** Includes open reservations; may exceed 100 after an overshoot. */
  used_pct: number
  /** Null while the window is inactive — it starts at the next use. */
  resets_at: string | null
  active: boolean
  /**
   * False = this allowance NEVER comes back: it is the Free plan's one-time
   * trial credit, not a window. Absent on an older server, which only ever
   * sent windows that do reset — so absent means it resets.
   */
  resets?: boolean
}

export interface UsageEstimate {
  fits: 'plan' | 'wallet' | 'none'
  /** This run's share of each enforced limit, in percent. */
  pct: Partial<Record<LimitKey, number>>
  /** What the top-up balance would pay when `fits === 'wallet'`. */
  wallet_satang: number
  binding: LimitKey | null
  resets_at: string | null
  /** False = the binding allowance never comes back (see `UsageLimit.resets`). */
  resets?: boolean
  unlimited: boolean
}

export interface EstimateRequest {
  /** Route-level kind when the caller knows it (`plan_effects`, `reedit`);
   * the server derives it from `mode` when absent. */
  kind?: string
  mode: string
  engine?: 'lite' | 'pro'
  precision?: 'standard' | 'high'
  clips: { duration_sec: number; has_audio: boolean }[]
}

export type RefusalCode = 'limit_reached' | 'free_tier_limited' | 'service_paused' | 'limit_stop'

/** A start the server refused (402/429/503) or a run it stopped. */
export interface BillingRefusal {
  code: RefusalCode
  window: LimitKey | null
  resetsAt: string | null
  /** False = the allowance never comes back (see `UsageLimit.resets`); there
   * is no waiting it out, only a plan change. */
  resets: boolean
  /** The top-up balance can pay for this run ("continue with balance"). */
  walletCanCover: boolean
  walletSatang: number
  /** The server's own Thai sentence, used when this module has nothing better. */
  serverMessage: string | null
}

// ── labels ───────────────────────────────────────────────────────────────────

export const LIMIT_LABELS: Record<LimitKey, string> = {
  monthly: 'โควตารายเดือน',
  weekly: 'โควตารายสัปดาห์',
  five_hour: 'โควตารอบ 5 ชั่วโมง',
  lifetime: 'เครดิตทดลองใช้'
}

export function limitLabel(key: string | null | undefined): string {
  return LIMIT_LABELS[key as LimitKey] ?? 'โควตา'
}

/** Plan ids → the name the plans list uses. Unknown ids show as sent. */
const PLAN_NAMES: Record<string, string> = {
  free: 'ฟรี',
  lite: 'Lite',
  starter: 'Starter',
  pro: 'Pro',
  studio: 'Studio',
  agency: 'Agency',
  max: 'Max',
  enterprise: 'Enterprise'
}

export function planName(plan: string | null | undefined): string {
  const id = (plan ?? '').trim().toLowerCase()
  return PLAN_NAMES[id] ?? (plan || 'ฟรี')
}

/** "ใช้ไป 42%" — whole percent, never below 0. Over 100 stays over 100: an
 * overshoot is real and the bar alone would hide it. */
export function pctText(pct: number | null | undefined): string {
  return `${Math.max(0, Math.round(pct ?? 0))}%`
}

/** Bar and value colour (design §1): ≥95 % error, ≥80 % accent, else text. */
export function usageTone(pct: number): 'error' | 'accent' | 'ink' {
  if (pct >= 95) return 'error'
  if (pct >= 80) return 'accent'
  return 'ink'
}

// ── time ─────────────────────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "1 ชม. 48 นาที" / "12 นาที" — at least one minute, so it never says "0 นาที". */
export function durationTh(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / MINUTE))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m} นาที`
  return m === 0 ? `${h} ชม.` : `${h} ชม. ${m} นาที`
}

function fmt(iso: string, opts: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Intl.DateTimeFormat('th-TH', { ...opts, ...(timeZone ? { timeZone } : {}) }).format(
    new Date(iso)
  )
}

/** "พฤหัสบดี" — Thai weekday without the "วัน" prefix Intl adds. */
function weekday(iso: string, timeZone?: string): string {
  return fmt(iso, { weekday: 'long' }, timeZone).replace(/^วัน/, '')
}

/** "09:40", 24-hour. */
function clock(iso: string, timeZone?: string): string {
  return fmt(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone)
}

/** "1 ต.ค." */
function dayMonth(iso: string, timeZone?: string): string {
  return fmt(iso, { day: 'numeric', month: 'short' }, timeZone)
}

function validIso(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && !Number.isNaN(new Date(iso).getTime())
}

/**
 * The line under a meter (design §1), in the viewer's timezone:
 *   five_hour  "รอบใหม่ใน 1 ชม. 48 นาที"
 *   weekly     "รอบใหม่ พฤหัสบดี 09:40"
 *   monthly    "รีเซ็ต 1 ต.ค."
 * An inactive window has no reset time — it starts counting at the next use.
 */
export function resetLine(
  key: LimitKey,
  resetsAt: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string
): string {
  if (!validIso(resetsAt)) return 'เริ่มนับรอบใหม่เมื่อใช้งานครั้งถัดไป'
  const left = new Date(resetsAt).getTime() - now.getTime()
  if (left <= 0) return 'รอบใหม่เริ่มแล้ว'
  if (key === 'five_hour') return `รอบใหม่ใน ${durationTh(left)}`
  if (key === 'weekly') return `รอบใหม่ ${weekday(resetsAt, timeZone)} ${clock(resetsAt, timeZone)}`
  return `รีเซ็ต ${dayMonth(resetsAt, timeZone)}`
}

// ── an allowance that never resets (the Free trial credit) ───────────────────

/**
 * `resets: false` means the allowance does not come back — there is no window
 * to count down to, and a countdown would read "รีเซ็ตใน 0 วินาที" forever.
 * What is left to say is whether it is spent and how to get more.
 */
export const TRIAL_CREDIT_SPENT = 'เครดิตทดลองใช้หมดแล้ว'
export const TRIAL_CREDIT_LEFT = 'เครดิตทดลองใช้ครั้งเดียว ไม่รีเซ็ตรายเดือน'
/** The action offered wherever a reset time would otherwise have been. */
export const TRIAL_CREDIT_ACTION = 'เปลี่ยนแผนเพื่อใช้ต่อ'

/** The standing advice on a credit that does not come back. */
export const TRIAL_CREDIT_HINT = 'ใช้หมดแล้วอัปเกรด'

/** True when the server said this allowance never comes back. Absent = it does. */
export function neverResets(o: { resets?: boolean | null } | null | undefined): boolean {
  return o?.resets === false
}

/**
 * The NAME of a quota meter. A credit that never returns must not be called
 * "โควตารายเดือน": the window name is the very thing that is untrue about it.
 */
export function windowTitle(l: { key: LimitKey; resets?: boolean }): string {
  return neverResets(l) ? 'เครดิตทดลองใช้' : limitLabel(l.key)
}

/** The line under a non-resetting meter: spent, or not spent yet. */
export function trialCreditLine(usedPct: number): string {
  return usedPct >= 100 ? TRIAL_CREDIT_SPENT : TRIAL_CREDIT_LEFT
}

/**
 * The line under ONE quota meter, whichever kind it is: a reset time for a
 * rolling window, the trial-credit sentence for an allowance that never
 * returns. Every meter in the editor goes through here so neither can ever
 * be shown with the other's wording.
 */
export function windowLine(
  l: Pick<UsageLimit, 'key' | 'used_pct' | 'resets_at' | 'active'> & { resets?: boolean },
  now: Date = new Date(),
  timeZone?: string
): string {
  if (neverResets(l)) return trialCreditLine(l.used_pct)
  // `active` is NOT a gate on the date any more. A monthly window now runs
  // from one billing anniversary to the next (packages/billing/runs.py), so a
  // paid account that has not cut anything yet this month reads as inactive
  // and still has a real next reset — the subscription's date, not the
  // usage's. Dropping it here told that user "the cycle starts at your next
  // use", which was true of a rolling window and is false of this one. The
  // rolling sub-windows send no date while inactive, so they are unaffected.
  return resetLine(l.key, l.resets_at, now, timeZone)
}

/**
 * When work can start again (design §3, "กลับมาเริ่มงานใหม่ได้ …"):
 * under a day → "อีก 1 ชม. 48 นาที"; within a week → "พฤหัสบดี 09:40";
 * further → "1 ต.ค.". Empty when the server gave no time.
 */
export function whenBack(
  resetsAt: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string
): string {
  if (!validIso(resetsAt)) return ''
  const left = new Date(resetsAt).getTime() - now.getTime()
  if (left <= 0) return 'ตอนนี้'
  if (left < DAY) return `อีก ${durationTh(left)}`
  if (left < 7 * DAY) return `${weekday(resetsAt, timeZone)} ${clock(resetsAt, timeZone)}`
  return dayMonth(resetsAt, timeZone)
}

// ── what a run costs, before it starts ───────────────────────────────────────

/**
 * This run's share of the quota it will be charged against, as a whole
 * percent.
 *
 * A PERCENTAGE, never a count of anything (owner: percent-only meters,
 * 2026-09-22 and again 2026-09-29). A countable unit cannot survive this cost
 * shape — an ordinary cut and a 30-minute high-quality one differ by more
 * than fourfold, so a meter reading "22 คลิป" would drop by four on a single
 * upload and read as broken. A percentage cannot contradict itself that way:
 * one run takes 5%, a longer one takes 12%, and nobody expected them to be
 * equal. ("คลิป" is also already this codebase's word for a source video
 * file — `local_meta.clips`, `clip_secs` — so it cannot mean a unit of
 * spending as well.)
 *
 * Floored at 1: a run that is charged at all must not read as free. Null when
 * nothing can answer — an unlimited account, or no estimate — and the caller
 * then says NOTHING rather than guess.
 */
export function runSharePct(est: UsageEstimate | null | undefined): number | null {
  if (!est || est.unlimited) return null
  const binding = est.binding ? est.pct[est.binding] : undefined
  const others = Object.values(est.pct).filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n)
  )
  // The binding window is the one the run is measured against; the fullest is
  // the honest fallback for a payload that named none.
  const share =
    typeof binding === 'number' && Number.isFinite(binding)
      ? binding
      : others.length
        ? Math.max(...others)
        : 0
  if (!(share > 0)) return null
  return Math.max(1, Math.round(share))
}

/**
 * "งานนี้ใช้ประมาณ 5% ของโควตารายเดือน" — what a run costs, said before the
 * user commits to it.
 *
 * This line is what makes a percentage answer the question a person actually
 * has ("how many more runs do I have?"). Null when the estimate cannot say.
 */
export function runCostLine(est: UsageEstimate | null | undefined): string | null {
  const pct = runSharePct(est)
  if (pct === null || !est) return null
  return `งานนี้ใช้ประมาณ ${pct}% ของ${limitLabel(est.binding)}`
}

/** "~5%" — the same fact on a button, where there is no room for prose. */
export function runCostChip(est: UsageEstimate | null | undefined): string | null {
  const pct = runSharePct(est)
  return pct === null ? null : `~${pct}%`
}

/** The two strings of one quota meter. */
export interface MeterCopy {
  /** The headline, right of the window's name. */
  value: string
  /** The muted line under the bar. */
  line: string
}

/**
 * What one quota meter says: the percentage used, and under it either when
 * the window comes back or — for a credit that never does — what to do when
 * it runs out. Every meter in the editor goes through here, so neither kind
 * can ever be shown with the other's wording, and no meter can drift back to
 * counting in clips (`usageLimits.test.ts` pins that).
 */
export function meterCopy(
  l: Pick<UsageLimit, 'key' | 'used_pct' | 'resets_at' | 'active'> & { resets?: boolean },
  now: Date = new Date(),
  timeZone?: string
): MeterCopy {
  return {
    value: `ใช้ไป ${pctText(l.used_pct)}`,
    // A credit that never comes back has no countdown to give, so its line is
    // the only thing left to say: what to do when it runs out.
    line: neverResets(l) ? TRIAL_CREDIT_HINT : windowLine(l, now, timeZone)
  }
}

// ── money ────────────────────────────────────────────────────────────────────

/** "฿299.50" — a balance always shows satang. */
export function formatBaht(satang: number): string {
  const baht = Math.max(0, Math.round(satang)) / 100
  return `฿${baht.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "฿1,000" — a pack price is whole baht. */
export function formatPack(satang: number): string {
  const baht = Math.round(satang) / 100
  return `฿${baht.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** "6.2 / 10 GB" (design §1); "6.2 GB · ไม่จำกัด" for an unlimited plan. */
export function storageText(usedBytes: number, quotaBytes: number): string {
  const gb = (b: number): string => {
    const v = Math.max(0, b) / 1024 ** 3
    return v >= 10 || Number.isInteger(v) ? String(Math.round(v * 10) / 10) : v.toFixed(1)
  }
  if (quotaBytes <= 0) return `${gb(usedBytes)} GB · ไม่จำกัด`
  return `${gb(usedBytes)} / ${gb(quotaBytes)} GB`
}

/** A date the user plans around ("26 ก.ย."), in the viewer's timezone. */
export function shortDate(iso: string | null | undefined, timeZone?: string): string {
  return validIso(iso) ? dayMonth(iso, timeZone) : ''
}

/** Payment methods in the order they are offered: PromptPay first (cheapest
 * for the owner, and what most Thai buyers reach for). */
export function orderedMethods(methods: readonly string[]): string[] {
  const rank = (m: string): number => (m === 'promptpay' ? 0 : m === 'card' ? 1 : 2)
  return [...methods].sort((a, b) => rank(a) - rank(b))
}

export const METHOD_LABELS: Record<string, string> = {
  promptpay: 'พร้อมเพย์',
  card: 'บัตรเครดิต/เดบิต'
}

export const LEDGER_LABELS: Record<string, string> = {
  purchase: 'เติมเงิน',
  debit: 'ใช้ทำงาน',
  refund: 'คืนเงิน',
  expire: 'หมดอายุ',
  adjust: 'ปรับยอดโดยทีมงาน',
  // A top-up refunded or disputed at the payment provider, taken back out.
  reversal: 'ยกเลิกการเติมเงิน'
}

/**
 * Whether a checkout URL means the top-up is ALREADY credited.
 *
 * On a local deployment without a payment provider the server credits the
 * balance at once and answers with the return URL itself
 * (`…?topup=success`); a real checkout URL carries no such parameter. The web
 * cannot open the return URL — it points at the marketing site — so the
 * caller refreshes the balance instead of navigating.
 */
export function checkoutAlreadyCredited(url: string): boolean {
  try {
    return new URL(url).searchParams.get('topup') === 'success'
  } catch {
    return false
  }
}

// ── estimate ─────────────────────────────────────────────────────────────────

/** Windows of an estimate, fullest first. */
function estimateParts(est: UsageEstimate): { key: LimitKey; pct: number }[] {
  return (Object.entries(est.pct) as [LimitKey, number | undefined][])
    .filter((e): e is [LimitKey, number] => typeof e[1] === 'number' && e[1] >= 0)
    .map(([key, pct]) => ({ key, pct }))
    .sort((a, b) => b.pct - a.pct)
}

function approxPct(pct: number): string {
  return pct < 1 ? 'ไม่ถึง 1%' : `ประมาณ ${Math.round(pct)}%`
}

/**
 * "ใช้ประมาณ 18% ของโควตารายสัปดาห์" — every enforced window, fullest first
 * ("ใช้ประมาณ 45% ของโควตารอบ 5 ชั่วโมง · 18% ของโควตารายสัปดาห์").
 * Null for an unlimited account or an estimate with no windows.
 */
export function estimateLine(est: UsageEstimate): string | null {
  if (est.unlimited) return null
  const parts = estimateParts(est)
  if (parts.length === 0) return null
  const [first, ...rest] = parts
  const head = `ใช้${approxPct(first.pct)} ของ${limitLabel(first.key)}`
  const tail = rest.map(
    (p) => `${approxPct(p.pct).replace(/^ประมาณ /, '')} ของ${limitLabel(p.key)}`
  )
  return [head, ...tail].join(' · ')
}

/**
 * Why a run does not fit, for the line under the estimate. NOT the run's
 * price — that is `runCostLine`, which every paid start shows.
 */
export function estimateBlockLine(est: UsageEstimate, now: Date = new Date()): string | null {
  if (est.unlimited || est.fits === 'plan') return null
  // A credit that never resets has no "wait for the next window" way out: the
  // only honest ending is the plan change.
  if (neverResets(est)) {
    const base = `เครดิตทดลองใช้เหลือไม่พอสำหรับงานนี้ · ${TRIAL_CREDIT_ACTION}`
    return est.fits === 'wallet'
      ? `${base} — ใช้ยอดเงินคงเหลือ ${formatBaht(est.wallet_satang)} ทำต่อได้`
      : base
  }
  const label = limitLabel(est.binding)
  const back = whenBack(est.resets_at, now)
  const base = `${label}เหลือไม่พอสำหรับงานนี้${back ? ` · รอบใหม่${back.startsWith('อีก') ? '' : ' '}${back}` : ''}`
  if (est.fits === 'wallet')
    return `${base} — ใช้ยอดเงินคงเหลือ ${formatBaht(est.wallet_satang)} ทำต่อได้`
  return base
}

// ── refusals ─────────────────────────────────────────────────────────────────

const REFUSAL_CODES: readonly RefusalCode[] = [
  'limit_reached',
  'free_tier_limited',
  'service_paused',
  'limit_stop'
]

function asKey(v: unknown): LimitKey | null {
  return v === 'five_hour' || v === 'weekly' || v === 'monthly' || v === 'lifetime' ? v : null
}

/** The refusal object inside `detail`, from a parsed error body; null when the
 * body is anything else (a plain string detail, a 422 list, no body). */
export function parseRefusal(body: unknown): BillingRefusal | null {
  const detail = (body as { detail?: unknown } | null | undefined)?.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  return refusalFrom(detail as Record<string, unknown>)
}

/** Same, from an object that IS the refusal (a job row's `result`). */
export function refusalFrom(
  obj: Record<string, unknown> | null | undefined
): BillingRefusal | null {
  const code = obj?.code
  if (typeof code !== 'string' || !REFUSAL_CODES.includes(code as RefusalCode)) return null
  const o = obj as Record<string, unknown>
  return {
    code: code as RefusalCode,
    window: asKey(o.window),
    resetsAt: typeof o.resets_at === 'string' ? o.resets_at : null,
    // Absent on an older server, which only refused windows that do reset.
    resets: o.resets !== false,
    walletCanCover: o.wallet_can_cover === true,
    walletSatang: typeof o.wallet_satang === 'number' ? o.wallet_satang : 0,
    serverMessage: typeof o.message === 'string' && o.message.trim() ? o.message.trim() : null
  }
}

/**
 * The sentence a person reads for a refusal — with the reset time in THEIR
 * timezone, which the server's own message cannot carry.
 */
export function refusalMessage(r: BillingRefusal, now: Date = new Date()): string {
  switch (r.code) {
    case 'limit_reached': {
      const wallet = r.walletCanCover ? ' — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้' : ''
      // Nothing to wait for: the credit is spent once and does not return.
      if (!r.resets) return `${TRIAL_CREDIT_SPENT} · ${TRIAL_CREDIT_ACTION}${wallet}`
      const back = whenBack(r.resetsAt, now)
      const head = `${limitLabel(r.window)}หมดแล้ว`
      const when = back ? ` · เริ่มงานใหม่ได้${back.startsWith('อีก') ? '' : ' '}${back}` : ''
      return `${head}${when}${wallet}`
    }
    case 'limit_stop':
      return 'หยุดแล้ว: งานนี้ใช้มากกว่าที่ประเมินไว้ ระบบจึงหยุดไว้ก่อนไม่ให้กินโควตาเกิน — กดลองใหม่ได้'
    case 'service_paused':
      return r.serverMessage ?? 'ระบบหยุดรับงาน AI ชั่วคราว กรุณาลองใหม่ภายหลัง'
    case 'free_tier_limited':
      return (
        r.serverMessage ??
        'แผนฟรีเริ่มงาน AI จากเครื่องหรือเครือข่ายนี้ครบจำนวนแล้ว ลองใหม่ภายหลัง หรือเปลี่ยนแผน'
      )
  }
}

// ── job rows ─────────────────────────────────────────────────────────────────

/** A job waiting behind the plan's concurrency cap (`step: "waiting_slot"`). */
export function isWaitingSlot(result: Record<string, unknown> | null | undefined): boolean {
  return result?.step === 'waiting_slot'
}

/** The refusal a STOPPED job row carries (`step: "stopped"`), else null. */
export function jobStopRefusal(
  result: Record<string, unknown> | null | undefined
): BillingRefusal | null {
  if (result?.step !== 'stopped') return null
  return (
    refusalFrom(result) ?? {
      code: 'limit_stop',
      window: null,
      resetsAt: null,
      resets: true,
      walletCanCover: false,
      walletSatang: 0,
      serverMessage: typeof result.message === 'string' ? result.message : null
    }
  )
}

/** "ทำพร้อมกันได้ 2 งาน งานที่สามจะเริ่มเองเมื่อมีช่องว่าง" (design §4). */
export function queueNotice(max: number | null | undefined): string {
  const n = Math.max(1, Math.round(max ?? 1))
  const next = ['', 'ที่สอง', 'ที่สาม', 'ที่สี่', 'ที่ห้า', 'ที่หก'][n] ?? `ที่ ${n + 1}`
  return n === 1
    ? 'แผนนี้ทำได้ครั้งละ 1 งาน งานนี้จะเริ่มเองเมื่องานก่อนหน้าเสร็จ'
    : `ทำพร้อมกันได้ ${n} งาน งาน${next}จะเริ่มเองเมื่อมีช่องว่าง`
}

// ── device id ────────────────────────────────────────────────────────────────

const DEVICE_KEY = 'noey.deviceId'
let memoryDeviceId: string | null = null

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '')
  } catch {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  }
}

/**
 * A random id per install, sent as `X-Noey-Device` so the server can apply
 * the free-tier limits per device as well as per IP. Not an identity: it is
 * made up here, kept in local storage (the desktop's lives under userData),
 * and a private window simply gets a fresh one.
 */
export function deviceId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
): string {
  try {
    const stored = storage?.getItem(DEVICE_KEY)
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored
    const id = randomId()
    storage?.setItem(DEVICE_KEY, id)
    return id
  } catch {
    memoryDeviceId ??= randomId()
    return memoryDeviceId
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const DEVICE_HEADER = 'X-Noey-Device'
