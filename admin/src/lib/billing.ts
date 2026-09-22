/**
 * Pure helpers for the FX, reconciliation, limit, wallet and breaker views — shared by the server
 * actions (argument checks) and the components. The backend re-validates all
 * of it (backend/services/api/routers/admin.py).
 */

import type { AccuracyStats, BreakerSettings, FailedRunsSummary, Vendor, WindowKey } from "./types";

/** THB per USD the backend accepts (packages/billing/fx.py SANE_BAND). */
export const FX_BAND: [number, number] = [25, 50];
export const VENDORS: Vendor[] = ["gemini", "elevenlabs"];

/** What each vendor bills for — the admin names the work, not the vendor. */
export const VENDOR_LABELS: Record<Vendor, string> = {
  gemini: "AI ตัดต่อ",
  elevenlabs: "ถอดเสียง",
};

const FX_SOURCE_LABELS: Record<string, string> = {
  override: "กำหนดเอง",
  "open.er-api.com": "ดึงอัตโนมัติ",
  "frankfurter.app": "ดึงอัตโนมัติ (สำรอง)",
  cost_config: "ค่าสำรองในตั้งค่าต้นทุน",
  default: "ค่าตั้งต้น ฿34.5",
};

export function fxSourceLabel(source: string): string {
  return FX_SOURCE_LABELS[source] ?? source;
}

export function validMonth(month: unknown): month is string {
  return typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function validFxOverride(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= FX_BAND[0] && v <= FX_BAND[1]);
}

export function validInvoice(vendor: unknown, amount: unknown): boolean {
  return (
    VENDORS.includes(vendor as Vendor) &&
    typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= 100_000_000
  );
}

/** "2026-09" for a YYYY-MM-DD day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** The month before `month` (YYYY-MM). */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// ── limits, wallet, runs, breaker ───────────────────────────────────────────

/** Limit names stay English everywhere (owner decision 2026-09-22). */
export const WINDOW_LABELS: Record<WindowKey, string> = {
  five_hour: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};
export const WINDOW_KEYS: WindowKey[] = ["five_hour", "weekly", "monthly"];

export function validWindow(w: unknown): w is WindowKey {
  return WINDOW_KEYS.includes(w as WindowKey);
}

/** Admin wallet adjustment: signed whole satang within the backend's ±฿100,000, and a reason. */
export const WALLET_ADJUST_MAX_SATANG = 10_000_000;

export function validWalletAdjust(satang: unknown, note: unknown): boolean {
  return (
    typeof satang === "number" && Number.isInteger(satang) && satang !== 0 &&
    Math.abs(satang) <= WALLET_ADJUST_MAX_SATANG &&
    typeof note === "string" && note.trim().length >= 1 && note.trim().length <= 200
  );
}

/** Baht typed in the form → whole satang (฿12.345 → 1235). */
export function bahtToSatang(thb: number): number {
  return Math.round(thb * 100);
}

export function validBreaker(b: unknown): b is BreakerSettings {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  const email = x.alert_email;
  return (
    typeof x.enabled === "boolean" &&
    typeof x.daily_cap_thb === "number" && Number.isFinite(x.daily_cap_thb) && x.daily_cap_thb >= 0 && x.daily_cap_thb <= 10_000_000 &&
    typeof x.hard_stop_ratio === "number" && Number.isFinite(x.hard_stop_ratio) && x.hard_stop_ratio >= 1 && x.hard_stop_ratio <= 10 &&
    (email === null || (typeof email === "string" && email.length <= 255 && (email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))))
  );
}

export function validPer1M(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10_000;
}

/**
 * A UTC ISO time from the API in the VIEWER's own timezone (the browser's),
 * e.g. "22 ก.ย. 14:30". Call it only in the browser (event-driven UI), never
 * during server render, or the server's timezone would leak in.
 */
export function formatResetAt(iso: string | null, timeZone?: string): string {
  if (!iso) return "เริ่มนับเมื่อใช้ครั้งถัดไป";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
  }).format(d);
}

export const OUTCOME_LABEL: Record<string, string> = {
  ok: "สำเร็จ",
  limit_stop: "หยุดเพราะเกินงบงาน",
  our_failure: "ระบบผิดพลาด (คืนโควตา)",
  user_cancel: "ผู้ใช้หยุดเอง",
  user_error: "ไฟล์/ข้อมูลผิด",
  orphaned: "ค้าง (คืนโควตา)",
};

export const RUN_KIND_LABEL: Record<string, string> = {
  analyze_video: "วิเคราะห์วิดีโอ",
  analyze_frames: "วิเคราะห์เฟรม",
  transcribe_audio: "ถอดเสียง + วางแผน",
  plan_dub: "วางไทม์ไลน์พากย์",
  reedit: "ตัดใหม่",
  plan_effects: "วางเอฟเฟกต์",
  distill_style: "สรุปสไตล์",
  server_pipeline: "ตัดบนเซิร์ฟเวอร์",
  voiceover: "เสียงพากย์",
};

export type AccuracyVerdict = "none" | "good" | "under" | "over";

/**
 * How the estimator is doing: "under" when a typical run uses more than it
 * reserved (median > 1.1, or 10%+ runs past the ceiling) — users get stopped
 * or overshoot; "over" when runs typically use under 60% of the estimate —
 * users are refused starts that would have fitted.
 */
export function accuracyVerdict(a: AccuracyStats | null | undefined): AccuracyVerdict {
  if (!a || a.runs === 0 || a.median_ratio === null) return "none";
  if (a.median_ratio > 1.1 || a.over_ceiling / a.runs >= 0.1) return "under";
  if (a.median_ratio < 0.6) return "over";
  return "good";
}

/** Refunded failures in 30 days at which the drawer asks the admin to look. */
export const FAILED_RUNS_WATCH = 3;

export type FailedRunsVerdict = "none" | "normal" | "watch";

/**
 * Whether a user's failed runs look like abuse: any run charged after the
 * daily refund allowance, or several refunded failures in the window.
 */
export function failedRunsVerdict(s: FailedRunsSummary | null | undefined): FailedRunsVerdict {
  if (!s || s.runs === 0) return "none";
  if (s.charged_after_cap_runs > 0 || s.refunded_runs >= FAILED_RUNS_WATCH) return "watch";
  return "normal";
}

/**
 * A run's outcome for the drawer. ``our_failure`` normally means refunded; one
 * past the user's daily refund allowance was charged instead (status settled).
 */
export function outcomeLabel(outcome: string | null, status: string): string {
  if (outcome === "our_failure" && status === "settled") return "ระบบผิดพลาด (เกินสิทธิ์คืนโควตา — คิดตามที่ใช้)";
  if (!outcome) return status === "running" ? "กำลังทำ" : status === "queued" ? "รอคิว" : status;
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function ratioLabel(r: number | null): string {
  return r === null ? "—" : `×${r.toFixed(2)}`;
}
