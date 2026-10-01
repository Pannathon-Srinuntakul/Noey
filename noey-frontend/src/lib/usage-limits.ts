/**
 * Pure helpers for the account quota tab (GET /usage/me `limits[]`).
 *
 * The site never shows token counts — only a percentage per enforced window and
 * when that window starts over. Labels stay in English to match the pricing
 * page ("Monthly limit", "Weekly limit", "Trial credit"; the 5-hour label stays
 * for rows an older account may still report).
 *
 * Since 2026-10-01 (backend limits.py rule 1, docs/token-billing-design.md
 * §24–§25): Pro and up report TWO windows, `monthly` and a rolling `weekly`
 * one sized 40% of the month, and a window can pass 100% — the AI step in
 * flight when the quota ran out is charged in full, and the excess counts
 * toward the window's next round. The words for that mirror the editor's own
 * (web/src/lib/usageLimits.ts `overageLine`, `resetLine`), so the site and the
 * editor say the same thing.
 */
import { WEEKLY_SHARE_PERCENT } from "./plans";

export type LimitKey = "five_hour" | "weekly" | "monthly" | "lifetime";

export interface UsageLimit {
  key: LimitKey | string;
  label?: string;
  used_pct: number;
  /** UTC ISO; null = the window has not started (it starts at the next job). */
  resets_at: string | null;
  active: boolean;
  /**
   * False = the allowance never comes back (the free plan's one-off trial
   * credit). Absent means it does reset, so an older backend keeps working.
   */
  resets?: boolean;
}

export const LIMIT_LABELS: Record<LimitKey, string> = {
  five_hour: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
  // The free plan's one-off credit. Mirrors the backend's
  // `packages/billing/limits.py:WINDOW_LABELS["lifetime"]`.
  lifetime: "Trial credit",
};

/** Display order: the longest window first, the way the pricing page lists them (and the server sends them). */
const ORDER: Record<string, number> = { lifetime: 0, monthly: 1, weekly: 2, five_hour: 3 };

export function limitLabel(limit: Pick<UsageLimit, "key" | "label">): string {
  return LIMIT_LABELS[limit.key as LimitKey] ?? limit.label ?? limit.key;
}

export function sortLimits<T extends Pick<UsageLimit, "key">>(limits: readonly T[]): T[] {
  return [...limits].sort((a, b) => (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9));
}

/** 0–100 for the bar width. `used_pct` includes open reservations and can pass 100. */
export function clampPct(pct: number | null | undefined): number {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * The percentage as printed: whole, never below 0, and NOT capped — a window
 * at 106% says 106% (the bar alone, full, would hide the overshoot).
 */
export function pctText(pct: number | null | undefined): string {
  const value = typeof pct === "number" && Number.isFinite(pct) ? pct : 0;
  return `${Math.max(0, Math.round(value))}%`;
}

/** How far past 100% a window went, in whole percent; 0 at or under 100 (and for a rounding hair over). */
export function overPct(pct: number | null | undefined): number {
  if (typeof pct !== "number" || !Number.isFinite(pct) || !(pct > 100)) return 0;
  return Math.max(0, Math.round(pct - 100));
}

/**
 * The line under a meter past 100%, word for word the editor's
 * (`usageLimits.overageLine`): the excess counts toward the next round, or —
 * for the trial credit — toward the plan subscribed to. Null at or under 100.
 */
export function overageText(limit: Pick<UsageLimit, "used_pct" | "resets">): string | null {
  const over = overPct(limit.used_pct);
  if (over < 1) return null;
  return neverResets(limit)
    ? `ใช้เกินเครดิตทดลอง ${over}% · จะนับรวมเมื่อสมัครแพลน`
    : `ใช้เกินโควตา ${over}% · จะนับรวมในรอบถัดไป`;
}

/** Bar tone: the editor's thresholds (≥95 full, ≥80 near). */
export function limitTone(pct: number): "full" | "near" | "ok" {
  if (pct >= 95) return "full";
  if (pct >= 80) return "near";
  return "ok";
}

/**
 * A window whose allowance never comes back. The backend says so with
 * `resets: false` (the free plan's trial credit); it may still send a
 * `resets_at`, which must NOT be shown as a countdown — there is nothing to
 * count down to.
 */
export function neverResets(limit: Pick<UsageLimit, "resets">): boolean {
  return limit.resets === false;
}

/**
 * What goes under a one-off credit's meter instead of a countdown: that it is
 * spent (or being spent), that it does not come back, and what to do next.
 */
export function spentCreditText(usedPct: number): string {
  return clampPct(usedPct) >= 100
    ? "ใช้เครดิตทดลองหมดแล้ว เครดิตนี้ไม่รีเซ็ต เลือกแพลนรายเดือนเพื่อใช้งานต่อ"
    : "เครดิตทดลองก้อนเดียว ใช้หมดแล้วจะไม่รีเซ็ต เลือกแพลนรายเดือนได้เมื่อต้องการใช้ต่อ";
}

/**
 * "รีเซ็ตอีกครั้งใน 12 วัน" / "… ใน 3 ชม. 20 นาที" / "… ใน 45 นาที".
 * Relative text is timezone-free, so it is safe to render on the server; the
 * absolute clock time is added in the viewer's timezone by the client.
 *
 * Without a date the window has not started: a weekly one counts its 7 days
 * from the next job (the editor's words, `usageLimits.resetLine`).
 */
export function resetInText(resetsAt: string | null, now: number = Date.now(), key?: LimitKey | string): string {
  if (!resetsAt) return key === "weekly" ? "เริ่มนับ 7 วันเมื่อใช้งานครั้งถัดไป" : "รอบใหม่เริ่มนับเมื่อเริ่มงานถัดไป";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "—";
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  if (minutes <= 0) return "รีเซ็ตแล้ว";
  const days = Math.floor(minutes / 1440);
  if (days >= 1) return `รีเซ็ตอีกครั้งใน ${days} วัน`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 1) return rest > 0 ? `รีเซ็ตอีกครั้งใน ${hours} ชม. ${rest} นาที` : `รีเซ็ตอีกครั้งใน ${hours} ชม.`;
  return `รีเซ็ตอีกครั้งใน ${minutes} นาที`;
}

/**
 * Each window's size as a share of the month: what makes two percentages
 * comparable. A week is `WEEKLY_SHARE_PERCENT` of the month, so 22% of the
 * week can leave less room than 38% of the month.
 */
const WINDOW_SHARE: Record<string, number> = { monthly: 1, lifetime: 1, weekly: WEEKLY_SHARE_PERCENT / 100 };

/**
 * The window that limits the NEXT job when a plan enforces more than one:
 * the one with the least room left, in month units (the backend's start check
 * makes a new job fit every window, and the tightest binds). Null when there
 * is only one window, or the shares are unknown.
 */
export function bindingKey(limits: readonly Pick<UsageLimit, "key" | "used_pct">[]): string | null {
  const known = limits.filter((limit) => WINDOW_SHARE[limit.key] !== undefined);
  if (known.length < 2) return null;
  let best: { key: string; room: number } | null = null;
  for (const limit of known) {
    const room = WINDOW_SHARE[limit.key] * (100 - (Number.isFinite(limit.used_pct) ? limit.used_pct : 0));
    if (!best || room < best.room) best = { key: limit.key, room };
  }
  return best?.key ?? null;
}

/**
 * The sentence under two meters: they count together, how the week relates to
 * the month, and which one the next job has to fit right now — or, once that
 * one is full, that new work waits for it to start over.
 */
export function bindingNote(key: string | null, usedPct = 0): string | null {
  if (!key) return null;
  const name = LIMIT_LABELS[key as LimitKey] ?? key;
  const lead = `สองเพดานนับพร้อมกัน Weekly limit เท่ากับ ${WEEKLY_SHARE_PERCENT}% ของ Monthly limit งานใหม่ต้องพอทั้งสองเพดาน`;
  return usedPct >= 100 ? `${lead} ตอนนี้ ${name} เต็มแล้ว งานใหม่จะเริ่มได้เมื่อเพดานนี้เริ่มรอบใหม่` : `${lead} ตอนนี้ ${name} เหลือน้อยกว่า`;
}

/** The mark beside the binding window's name. */
export function bindingTag(usedPct: number): string {
  return usedPct >= 100 ? "เต็มแล้ว" : "เหลือน้อยกว่า";
}

/** What a paused job does once more quota comes, said under a window at or past 100%. */
export const PAUSED_RESUME_NOTE = "งานที่หยุดพักไว้ กดทำต่อได้จากจุดเดิมเมื่อรอบใหม่เริ่ม หลังอัปเกรด หรือเมื่อใช้ยอดเงินเติม";

/** The same for the trial credit, which has no next round. */
export const PAUSED_RESUME_TRIAL_NOTE = "งานที่หยุดพักไว้ กดทำต่อได้จากจุดเดิมหลังสมัครแพลน";

/** The one-line explainer under the meters, per plan (design copy for Free). */
export function planLimitNote(plan: string): string | null {
  // Lite and Starter enforce one Monthly limit; Pro and up a Weekly one beside
  // it (backend limits.py rule 1, 2026-10-01) — the meters say so themselves.
  if (plan === "free") return "แพลนรายเดือนได้โควตาใหม่ทุกรอบบิลเป็น Monthly limit และแพลนใหญ่ขึ้นได้คลิปต่อบาทมากขึ้น";
  if (plan === "lite" || plan === "starter") return "Pro ขึ้นไปเลือกระดับละเอียดได้ ทำงานพร้อมกันได้หลายงาน และได้คลิปต่อบาทมากขึ้น";
  return null;
}
