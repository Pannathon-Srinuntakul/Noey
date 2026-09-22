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
 * (owner-approved 2026-09-22). The admin sees the real numbers; users only
 * ever see percentages. Weekly = monthly ÷ 4.33, 5-hour = 40% of weekly. */
export const PLAN_LIMITS: Record<string, { monthly: number; windows: Array<"five_hour" | "weekly" | "monthly">; concurrency: number; storageGb: number }> = {
  free: { monthly: 100_000, windows: ["monthly"], concurrency: 1, storageGb: 1 },
  lite: { monthly: 800_000, windows: ["weekly"], concurrency: 1, storageGb: 3 },
  starter: { monthly: 1_600_000, windows: ["weekly"], concurrency: 1, storageGb: 5 },
  pro: { monthly: 4_000_000, windows: ["weekly", "five_hour"], concurrency: 2, storageGb: 10 },
  studio: { monthly: 8_000_000, windows: ["weekly", "five_hour"], concurrency: 3, storageGb: 30 },
  agency: { monthly: 16_000_000, windows: ["weekly", "five_hour"], concurrency: 4, storageGb: 60 },
  max: { monthly: 28_000_000, windows: ["weekly", "five_hour"], concurrency: 5, storageGb: 100 },
};

export function weeklyLimit(monthly: number): number {
  return Math.floor(monthly / 4.33);
}

export function fiveHourLimit(monthly: number): number {
  return Math.floor(weeklyLimit(monthly) * 0.4);
}
