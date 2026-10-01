/**
 * Pure helpers for the account quota tab (GET /usage/me `limits[]`).
 *
 * The site never shows token counts — only a percentage per enforced window and
 * when that window starts over. Labels stay in English to match the pricing
 * page ("Monthly limit", "Trial credit"; the 5-hour and weekly labels stay for
 * rows an older account may still report).
 */

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

/** Display order: the longest window first, the way the pricing page lists them. */
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
 */
export function resetInText(resetsAt: string | null, now: number = Date.now()): string {
  if (!resetsAt) return "รอบใหม่เริ่มนับเมื่อเริ่มงานถัดไป";
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

/** The one-line explainer under the meters, per plan (design copy for Free). */
export function planLimitNote(plan: string): string | null {
  // Every paid plan enforces one Monthly limit and nothing else since
  // 2026-09-30 (backend limits.py rule 1) — no weekly or 5-hour tier to sell.
  if (plan === "free") return "แพลนรายเดือนได้โควตาใหม่ทุกรอบบิลเป็น Monthly limit และแพลนใหญ่ขึ้นได้คลิปต่อบาทมากขึ้น";
  if (plan === "lite" || plan === "starter") return "Pro ขึ้นไปเลือกระดับละเอียดได้ ทำงานพร้อมกันได้หลายงาน และได้คลิปต่อบาทมากขึ้น";
  return null;
}
