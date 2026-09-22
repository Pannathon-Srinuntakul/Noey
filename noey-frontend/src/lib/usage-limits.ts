/**
 * Pure helpers for the account quota tab (GET /usage/me `limits[]`).
 *
 * The site never shows token counts — only a percentage per enforced window and
 * when that window starts over. Labels stay in English to match the pricing
 * page ("5-hour limit", "Weekly limit", "Monthly limit").
 */

export type LimitKey = "five_hour" | "weekly" | "monthly";

export interface UsageLimit {
  key: LimitKey | string;
  label?: string;
  used_pct: number;
  /** UTC ISO; null = the window has not started (it starts at the next job). */
  resets_at: string | null;
  active: boolean;
}

export const LIMIT_LABELS: Record<LimitKey, string> = {
  five_hour: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};

/** Display order: the longest window first, the way the pricing page lists them. */
const ORDER: Record<string, number> = { monthly: 0, weekly: 1, five_hour: 2 };

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
  if (plan === "free") return "อัปเกรดแล้วเปลี่ยนเป็น Weekly limit ส่วน Pro ขึ้นไปมี 5-hour limit เพิ่มอีกชั้น";
  if (plan === "lite" || plan === "starter") return "Pro ขึ้นไปมี 5-hour limit เพิ่มอีกชั้น และทำงานพร้อมกันได้หลายงาน";
  return null;
}
