/**
 * The beta period — ONE dated constant that every beta behaviour derives from.
 *
 * Owner decision, 2026-09-29: a 50% beta discount on every paid plan, round
 * numbers ending in 9, no coupon codes. The discounted number is the one
 * charged (it is the Stripe price); the full price appears only as
 * struck-through text. 31 Dec 2026 is a hard stop for EVERYONE, including
 * accounts that subscribed during beta — there is no grandfathering, and from
 * 1 Jan 2027 every subscription bills the full price.
 *
 * Because every surface asks `isBetaActive()` at render time and the pricing
 * pages are ISR with a 10-minute window, the site reverts by itself when the
 * date passes: the struck-through price, the beta strips, the modal's point 2
 * and the pinned banner all disappear without a deploy.
 */

/** Last day the beta price applies, as a plain date. */
export const BETA_END_DATE_ISO = "2026-12-31";

/**
 * The instant the beta ends: midnight Bangkok time (UTC+7) at the START of
 * 1 Jan 2027, i.e. the end of 31 Dec 2026 for a Thai reader. Fixed rather than
 * derived from the visitor's zone, so everyone sees the same thing flip.
 */
export const BETA_END_INSTANT_MS = Date.UTC(2026, 11, 31, 17, 0, 0);

/** How the end date is written in Thai UI copy. */
export const BETA_END_LABEL = "31 ธ.ค. 2026";

export const BETA_DISCOUNT_PERCENT = 50;

/** Is the beta price still in force at `now`? */
export function isBetaActive(now: Date | number = Date.now()): boolean {
  const ms = now instanceof Date ? now.getTime() : now;
  return ms < BETA_END_INSTANT_MS;
}

// ─── Copy (Thai, user-visible) ───────────────────────────────────────────────

export const BETA_BADGE = "เบต้า";

/** The one-line price promise, used wherever a price is shown. */
export const BETA_PRICE_LINE = `ราคาเบต้า ลด ${BETA_DISCOUNT_PERCENT}% ถึง ${BETA_END_LABEL}`;

/** Standalone form: names the date itself, for prose that has not said it yet. */
export const BETA_PRICE_AFTER = `หมดวันที่ ${BETA_END_LABEL} รอบบิลถัดจากนั้นคิดราคาปกติทุกบัญชี รวมคนที่สมัครไว้แล้ว`;

/** The same fact right after `BETA_PRICE_LINE`, which already carried the date. */
export const BETA_PRICE_AFTER_SHORT = "หลังจากนั้นรอบบิลถัดไปคิดราคาปกติทุกบัญชี รวมคนที่สมัครไว้แล้ว";

/** Strip shown above every price grid. */
export const BETA_PRICE_NOTE = `${BETA_PRICE_LINE} · ${BETA_PRICE_AFTER_SHORT}`;

/** Short form for tight places (plan dialog, comparison table caption). */
export const BETA_PRICE_NOTE_SHORT = `${BETA_PRICE_LINE} · หลังจากนั้นคิดราคาปกติ`;

/** Label read out next to a struck-through full price. */
export const BETA_STRIKE_LABEL = "ราคาปกติ";

export const BETA_BANNER_TEXT = `${BETA_PRICE_LINE} · ตรวจคลิปก่อนลงทุกครั้ง`;
export const BETA_BANNER_LINK = "รายละเอียด";

export const BETA_NOTICE_TITLE = "ช่วงเบต้า มีสามเรื่องที่อยากให้รู้";

/**
 * Exactly three points, by the owner's decision — a fourth makes people read
 * none of them. Do not add to this array.
 */
export const BETA_NOTICE_POINTS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "ตรวจคลิปก่อนลงทุกครั้ง",
    body: "AI เลือกช็อตเก่งขึ้นเรื่อยๆ แต่ยังพลาดได้ ดูคลิปให้จบก่อนโพสต์เสมอ",
  },
  {
    title: `ราคาเบต้า ลด ${BETA_DISCOUNT_PERCENT}% ถึง ${BETA_END_LABEL}`,
    body: "หมดวันที่ 31 ธ.ค. กลับเป็นราคาปกติทุกแพลน รวมคนที่สมัครไว้แล้ว",
  },
  {
    title: "เก็บไฟล์ต้นฉบับไว้ที่เครื่องด้วย",
    body: "ช่วงเบต้ายังมีปิดปรับปรุงเป็นครั้งคราว และอาจต้องล้างข้อมูลทดสอบ",
  },
];

export const BETA_NOTICE_DISCLAIMER =
  "ช่วงเบต้า ฟีเจอร์ โควตา และราคาอาจเปลี่ยนแปลงได้ และอาจหยุดให้บริการชั่วคราวเพื่อปรับปรุง · " +
  "เนื้อหาที่ AI สร้างขึ้น ผู้ใช้เป็นผู้ตรวจและรับผิดชอบก่อนนำไปเผยแพร่ · " +
  `ราคาเบต้าสิ้นสุด ${BETA_END_LABEL} รอบบิลถัดจากนั้นคิดราคาปกติทุกบัญชี`;

export const BETA_NOTICE_DISMISS = "รับทราบ";
export const BETA_NOTICE_NEVER = "ไม่ต้องแสดงอีก";

// ─── When the modal may appear ───────────────────────────────────────────────

export const BETA_NOTICE_STORAGE_KEY = "noey.beta-notice.v1";

/** Dismissed without ticking the box: it comes back after a week. */
export const BETA_NOTICE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BetaNoticeState {
  /** Epoch ms of the last dismissal. */
  dismissedAt: number;
  /** "ไม่ต้องแสดงอีก" was ticked: never show it again in this browser. */
  forever: boolean;
}

/** Read back what this browser stored, ignoring anything that is not our shape. */
export function parseBetaNoticeState(raw: string | null | undefined): BetaNoticeState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const dismissedAt = record.dismissedAt;
    if (typeof dismissedAt !== "number" || !Number.isFinite(dismissedAt)) return null;
    return { dismissedAt, forever: record.forever === true };
  } catch {
    return null;
  }
}

/**
 * Pages the notice must never cover: a payment flow, and the plan/billing
 * screen where a payment is being started. A modal over a checkout is a
 * modal over someone's money.
 */
const PAYMENT_PATHS = ["/checkout", "/account/billing"];

export function isPaymentPath(pathname: string): boolean {
  return PAYMENT_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export interface BetaNoticeContext {
  now: number;
  stored: BetaNoticeState | null;
  pathname: string;
  /**
   * Something the visitor must not be interrupted during is in flight — the
   * marketing site marks this with `data-busy` on <html>. Nothing here renders
   * video today, so this is the hook for a surface that later does, and for a
   * checkout redirect already on its way.
   */
  busy: boolean;
}

/** The single decision: does the beta modal open right now? */
export function shouldShowBetaNotice({ now, stored, pathname, busy }: BetaNoticeContext): boolean {
  if (!isBetaActive(now)) return false;
  if (busy || isPaymentPath(pathname)) return false;
  if (!stored) return true;
  if (stored.forever) return false;
  return now - stored.dismissedAt >= BETA_NOTICE_SNOOZE_MS;
}

/** The slim strip that replaces the modal after it is dismissed. */
export function shouldShowBetaBanner(now: Date | number = Date.now()): boolean {
  return isBetaActive(now);
}
