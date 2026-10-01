/** Plan and mode wording for the admin screens. Plan keys are the backend's
 * PLAN_VALUES; quota copy mirrors noey-frontend's pricing page. */

import type { Tier } from "./types";

export const PLAN_KEYS: Tier[] = ["free", "lite", "starter", "pro", "studio", "agency", "max", "enterprise"];
/** Tiers with a sale price (the pricing table and forecast). */
export const PRICED_KEYS: Tier[] = ["free", "lite", "starter", "pro", "studio", "agency", "max"];
export const PAID_KEYS: Tier[] = ["lite", "starter", "pro", "studio", "agency", "max"];

export const PLAN_LABEL: Record<string, string> = {
  free: "ฟรี",
  lite: "Lite",
  starter: "Starter",
  pro: "Pro",
  studio: "Studio",
  agency: "Agency",
  max: "Max",
  enterprise: "Enterprise",
};

export const PLAN_QUOTA: Record<string, string> = {
  free: "รวม 5 นาที/โปรเจกต์",
  lite: "รวม 10 นาที/โปรเจกต์",
  starter: "รวม 20 นาที/โปรเจกต์",
  pro: "สูงสุด 2 ชั่วโมง",
  studio: "สูงสุด 2 ชั่วโมง",
  agency: "สูงสุด 2 ชั่วโมง",
  max: "สูงสุด 2 ชั่วโมง",
  enterprise: "ตามที่ตกลง",
};

export function planLabel(plan: string): string {
  return PLAN_LABEL[plan] ?? plan;
}

export const MODE_LABEL: Record<string, string> = {
  talking_head: "ตัดช่วงเงียบ",
  dub_first: "ตัดฉากเด่น",
  highlight: "ตัดฉากเด่น",
  speech_scenes: "ตัดฉากเด่น",
  speech_highlights: "คลิปยาวเป็นหลายคลิป",
};

export const STATUS_LABEL: Record<string, string> = {
  done: "เสร็จ",
  waiting_vo: "เสร็จ",
  error: "ล้มเหลว",
  processing: "กำลังทำ",
  pending: "รอเริ่ม",
  cancelled: "หยุดแล้ว",
};

/** Backend usage `feature` → the design's task buckets. */
export function taskForFeature(feature: string): "cut" | "fx" | "style" | "other" {
  if (feature === "video_cut" || feature === "video" || feature === "video_edit") return "cut";
  if (feature === "video_effects") return "fx";
  if (feature === "video_style") return "style";
  return "other";
}

export const TASK_USE_LABEL: Record<string, string> = {
  cut: "ตัดคลิป",
  fx: "วางเอฟเฟกต์กล้อง",
  style: "สรุปสไตล์",
  other: "งานข้อความ",
};

/** Plan limits in rate-card tokens — mirrors backend packages/billing/limits.py
 * (volume-discount budgets, owner 2026-10-01). The admin sees the real
 * numbers; users only ever see percentages. Free is a one-time `lifetime`
 * credit; Lite and Starter enforce `monthly`; Pro, Studio, Agency and Max
 * enforce `monthly` AND a rolling 7-day `weekly` of 40 % of it, whichever is
 * hit first (limits.py rule 1, owner 2026-10-01). The 5-hour helper stays
 * for rows that still record that window. */
export const PLAN_LIMITS: Record<string, { monthly: number; windows: Array<"five_hour" | "weekly" | "monthly" | "lifetime">; concurrency: number; storageGb: number }> = {
  free: { monthly: 450_000, windows: ["lifetime"], concurrency: 1, storageGb: 1 },
  lite: { monthly: 800_000, windows: ["monthly"], concurrency: 1, storageGb: 3 },
  starter: { monthly: 2_000_000, windows: ["monthly"], concurrency: 1, storageGb: 5 },
  pro: { monthly: 5_600_000, windows: ["monthly", "weekly"], concurrency: 2, storageGb: 10 },
  studio: { monthly: 12_000_000, windows: ["monthly", "weekly"], concurrency: 3, storageGb: 30 },
  agency: { monthly: 26_000_000, windows: ["monthly", "weekly"], concurrency: 4, storageGb: 60 },
  max: { monthly: 48_000_000, windows: ["monthly", "weekly"], concurrency: 5, storageGb: 100 },
};

/** The weekly window's share of the month (limits.py WEEKLY_SHARE). */
export const WEEKLY_SHARE = 0.4;

export function weeklyLimit(monthly: number): number {
  return Math.floor(monthly * WEEKLY_SHARE);
}

/** The unenforced 5-hour window keeps its old arithmetic (limits.py). */
export function fiveHourLimit(monthly: number): number {
  return Math.floor(Math.floor(monthly / 4.33) * 0.4);
}
