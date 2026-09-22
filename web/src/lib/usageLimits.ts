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

export type LimitKey = 'five_hour' | 'weekly' | 'monthly'

export interface UsageLimit {
  key: LimitKey
  /** English pricing-page label ("Weekly limit"); the editor shows `limitLabel(key)`. */
  label: string
  /** Includes open reservations; may exceed 100 after an overshoot. */
  used_pct: number
  /** Null while the window is inactive — it starts at the next use. */
  resets_at: string | null
  active: boolean
}

export interface UsageEstimate {
  fits: 'plan' | 'wallet' | 'none'
  /** This run's share of each enforced limit, in percent. */
  pct: Partial<Record<LimitKey, number>>
  /** What the top-up balance would pay when `fits === 'wallet'`. */
  wallet_satang: number
  binding: LimitKey | null
  resets_at: string | null
  unlimited: boolean
}

export interface EstimateRequest {
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
  five_hour: 'โควตารอบ 5 ชั่วโมง'
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

/** Why a run does not fit, for the line under the estimate. */
export function estimateBlockLine(est: UsageEstimate, now: Date = new Date()): string | null {
  if (est.unlimited || est.fits === 'plan') return null
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
  return v === 'five_hour' || v === 'weekly' || v === 'monthly' ? v : null
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
      const back = whenBack(r.resetsAt, now)
      const head = `${limitLabel(r.window)}หมดแล้ว`
      const when = back ? ` · เริ่มงานใหม่ได้${back.startsWith('อีก') ? '' : ' '}${back}` : ''
      const wallet = r.walletCanCover ? ' — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้' : ''
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
