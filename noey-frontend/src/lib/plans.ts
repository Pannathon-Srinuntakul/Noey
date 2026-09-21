/**
 * Plan catalog + price handling.
 *
 * The COPY (names, blurbs, feature bullets, comparison rows) is the designer's
 * and is static. PRICES come from the backend's `GET /billing/plans`, with the
 * design's mock prices as the build-time fallback only. Both the visible page
 * and every machine-readable surface (JSON-LD offers, /pricing.md, /llms.txt)
 * render prices from the same `PriceTable`, so they cannot disagree.
 */

export const TIERS = ["free", "lite", "starter", "pro", "studio"] as const;
export type Tier = (typeof TIERS)[number];

export const PAID_TIERS = ["lite", "starter", "pro", "studio"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === "string" && (PAID_TIERS as readonly string[]).includes(value);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** The backend's naming convention for Stripe price lookup keys. */
export function defaultLookupKey(tier: PaidTier): string {
  return `noey_${tier}_monthly`;
}

/** Design default props (THB / month) — used ONLY when the backend is unreachable at build time. */
export const FALLBACK_PRICES_THB: Record<PaidTier, number> = {
  lite: 190,
  starter: 290,
  pro: 930,
  studio: 1890,
};

export interface PaidPrice {
  /** Smallest currency unit (satang), exactly as Stripe/the backend report it. */
  amountSatang: number;
  lookupKey: string;
}

export type PriceSource = "stripe" | "mock" | "fallback";

export interface PriceTable {
  /** `stripe`/`mock` = reported by the backend; `fallback` = design prices baked in at build. */
  source: PriceSource;
  currency: "thb";
  prices: Partial<Record<PaidTier, PaidPrice>>;
}

export function fallbackPriceTable(): PriceTable {
  const prices: Partial<Record<PaidTier, PaidPrice>> = {};
  for (const tier of PAID_TIERS) {
    prices[tier] = { amountSatang: FALLBACK_PRICES_THB[tier] * 100, lookupKey: defaultLookupKey(tier) };
  }
  return { source: "fallback", currency: "thb", prices };
}

/**
 * Validate a `GET /billing/plans` body. Unknown tiers, non-monthly intervals
 * and non-integer amounts are dropped rather than trusted; a body that is not
 * the documented shape at all returns null so the caller can fall back.
 */
export function normalizePlansResponse(body: unknown): PriceTable | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const currency = typeof raw.currency === "string" ? raw.currency.toLowerCase() : "";
  if (currency !== "thb" || !Array.isArray(raw.plans)) return null;
  const source: PriceSource = raw.source === "stripe" ? "stripe" : "mock";

  const prices: Partial<Record<PaidTier, PaidPrice>> = {};
  for (const item of raw.plans) {
    if (!item || typeof item !== "object") continue;
    const plan = item as Record<string, unknown>;
    if (!isPaidTier(plan.tier)) continue;
    if (plan.interval !== undefined && plan.interval !== "month") continue;
    const amount = plan.unit_amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) continue;
    const lookupKey =
      typeof plan.lookup_key === "string" && plan.lookup_key.length > 0
        ? plan.lookup_key
        : defaultLookupKey(plan.tier);
    prices[plan.tier] = { amountSatang: amount, lookupKey };
  }
  if (Object.keys(prices).length === 0) return null;
  return { source, currency: "thb", prices };
}

/** `19000` satang -> `"190"`, `189000` -> `"1,890"`, `19050` -> `"190.50"`. Matches the design's en-US grouping. */
export function formatBaht(amountSatang: number): string {
  const baht = amountSatang / 100;
  if (Number.isInteger(baht)) return baht.toLocaleString("en-US");
  return baht.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Plain decimal string for schema.org `price` (no grouping separators). */
export function schemaPrice(amountSatang: number): string {
  const baht = amountSatang / 100;
  return Number.isInteger(baht) ? String(baht) : baht.toFixed(2);
}

export function priceFor(table: PriceTable, tier: PaidTier): PaidPrice | null {
  return table.prices[tier] ?? null;
}

/** Lowest listed paid price, for copy such as "เริ่ม 190 บาท/เดือน". */
export function lowestPaidPrice(table: PriceTable): PaidPrice | null {
  let lowest: PaidPrice | null = null;
  for (const tier of PAID_TIERS) {
    const price = table.prices[tier];
    if (price && (!lowest || price.amountSatang < lowest.amountSatang)) lowest = price;
  }
  return lowest;
}

export function lookupKeyFor(table: PriceTable, tier: PaidTier): string {
  return table.prices[tier]?.lookupKey ?? defaultLookupKey(tier);
}

/** Map a lookup key back to its tier, e.g. `noey_pro_monthly` -> `pro`. */
export function tierFromLookupKey(table: PriceTable, lookupKey: string | null | undefined): PaidTier | null {
  if (!lookupKey) return null;
  for (const tier of PAID_TIERS) {
    if (lookupKeyFor(table, tier) === lookupKey) return tier;
  }
  const match = /^noey_([a-z]+)_monthly$/.exec(lookupKey);
  return match && isPaidTier(match[1]) ? match[1] : null;
}

// ─── Copy (designer's text, verbatim) ────────────────────────────────────────

export interface PlanCopy {
  tier: Tier;
  name: string;
  /** Card sentence on the home page pricing strip. */
  homeBlurb: string;
  /** Card sentence on /pricing. */
  pricingBlurb: string;
  /** Bullet list on /pricing. */
  features: readonly string[];
  /** Bullets on the account billing card (design shows the free-plan version). */
  accountFeatures: readonly string[];
  /** One-line summary inside the upgrade dialog. */
  dialogSummary: string;
  /** Button label on /pricing. */
  pricingCta: string;
  recommended?: boolean;
}

export const PLAN_COPY: Record<Tier, PlanCopy> = {
  free: {
    tier: "free",
    name: "ฟรี",
    homeBlurb: "ลองระบบและตัดคลิปสั้นเป็นครั้งคราว",
    pricingBlurb: "ใช้ได้ต่อเนื่อง ไม่หมดอายุ",
    features: [
      "งาน AI ประมาณ 1 คลิปต่อรอบ 5 ชั่วโมง",
      "ฟุตเทจรวม 5 นาทีต่อโปรเจกต์",
      "ครบทุกโหมด รวมโหมดพากย์ใหม่",
      "เก็บได้ 3 โปรเจกต์ · 1 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 5 นาทีต่อโปรเจกต์", "เก็บได้ 3 โปรเจกต์ · 1 GB", "ครบทุกโหมด รวมโหมดพากย์ใหม่"],
    dialogSummary: "",
    pricingCta: "เริ่มใช้ฟรี",
  },
  lite: {
    tier: "lite",
    name: "Lite",
    homeBlurb: "ลงคลิปสัปดาห์ละไม่กี่ตัว เพิ่มเพลงประกอบ",
    pricingBlurb: "ลงคลิปสัปดาห์ละไม่กี่ตัว",
    features: [
      "งาน AI ประมาณ 2 คลิปต่อรอบ 5 ชั่วโมง",
      "ฟุตเทจรวม 10 นาทีต่อโปรเจกต์",
      "เพิ่มเพลงประกอบได้",
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 10 นาทีต่อโปรเจกต์", "เพิ่มเพลงประกอบได้", "เก็บได้ 10 โปรเจกต์ · 3 GB"],
    dialogSummary: "ฟุตเทจ 10 นาทีต่อโปรเจกต์ · 10 โปรเจกต์ · 3 GB",
    pricingCta: "เลือกแพลนนี้",
  },
  starter: {
    tier: "starter",
    name: "Starter",
    homeBlurb: "ลงคลิปสม่ำเสมอ ได้โหมดพากย์ใหม่ครบ",
    pricingBlurb: "สำหรับคนที่ลงคลิปหลายตัวต่อสัปดาห์",
    features: [
      "งาน AI ประมาณ 3 คลิปต่อรอบ 5 ชั่วโมง",
      "ฟุตเทจรวม 20 นาทีต่อโปรเจกต์",
      "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ",
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 20 นาทีต่อโปรเจกต์", "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ", "เก็บได้ 20 โปรเจกต์ · 5 GB"],
    dialogSummary: "ฟุตเทจ 20 นาทีต่อโปรเจกต์ · 20 โปรเจกต์ · 5 GB",
    pricingCta: "เลือกแพลนนี้",
  },
  pro: {
    tier: "pro",
    name: "Pro",
    homeBlurb: "ทำคลิปทุกวันหรือรับงานลูกค้าหลายเจ้า",
    pricingBlurb: "ทำคลิปทุกวัน หรือรับงานให้ลูกค้าหลายเจ้า",
    features: [
      "งาน AI ประมาณ 8 คลิปต่อรอบ 5 ชั่วโมง",
      "ฟุตเทจรวมสูงสุด 2 ชั่วโมงต่อโปรเจกต์",
      "คิวประมวลผลก่อนแพลนอื่น",
      "เก็บโปรเจกต์ไม่จำกัดจำนวน · 10 GB",
    ],
    accountFeatures: [
      "ฟุตเทจรวมสูงสุด 2 ชั่วโมงต่อโปรเจกต์",
      "คิวประมวลผลก่อนแพลนอื่น",
      "เก็บโปรเจกต์ไม่จำกัดจำนวน · 10 GB",
    ],
    dialogSummary: "ฟุตเทจสูงสุด 2 ชั่วโมง · โปรเจกต์ไม่จำกัด · 10 GB",
    pricingCta: "อัปเกรดเป็น Pro",
    recommended: true,
  },
  studio: {
    tier: "studio",
    name: "Studio",
    homeBlurb: "รับงานเป็นทีมหรือผลิตคลิปวันละหลายตัว",
    pricingBlurb: "ผลิตคลิปวันละหลายตัว หรือรับงานเป็นทีม",
    features: [
      "งาน AI ประมาณ 20 คลิปต่อรอบ 5 ชั่วโมง",
      "ฟุตเทจรวมสูงสุด 2 ชั่วโมงต่อโปรเจกต์",
      "คิวประมวลผลลำดับแรกสุด",
      "เก็บโปรเจกต์ไม่จำกัด · 30 GB",
    ],
    accountFeatures: ["ฟุตเทจรวมสูงสุด 2 ชั่วโมงต่อโปรเจกต์", "คิวประมวลผลลำดับแรกสุด", "เก็บโปรเจกต์ไม่จำกัด · 30 GB"],
    dialogSummary: "โควตาสูงสุด · คิวแรกสุด · 30 GB",
    pricingCta: "เลือกแพลนนี้",
  },
};

/**
 * Display name for any plan string the backend may report. The backend's
 * legacy plan values (`enterprise`) are not in the new tier list, so unknown
 * values are shown capitalised rather than hidden.
 */
export function planDisplayName(plan: string | null | undefined): string {
  if (!plan) return PLAN_COPY.free.name;
  if (isTier(plan)) return PLAN_COPY[plan].name;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Comparison table rows — designer's copy. Order follows TIERS. */
export const COMPARISON_ROWS: ReadonlyArray<{ label: string; values: readonly [string, string, string, string, string]; numeric?: boolean }> = [
  { label: "งาน AI ต่อรอบ 5 ชั่วโมง (โดยประมาณ)", values: ["1 คลิป", "2 คลิป", "3 คลิป", "8 คลิป", "20 คลิป"], numeric: true },
  { label: "เพดานรวมต่อสัปดาห์ (โดยประมาณ)", values: ["5 คลิป", "15 คลิป", "30 คลิป", "120 คลิป", "350 คลิป"], numeric: true },
  { label: "ฟุตเทจรวมต่อโปรเจกต์", values: ["5 นาที", "10 นาที", "20 นาที", "2 ชั่วโมง", "2 ชั่วโมง"], numeric: true },
  { label: "โหมดเก็บทุกฉาก และโหมดไฮไลต์", values: ["มี", "มี", "มี", "มี", "มี"] },
  { label: "โหมดพากย์ใหม่ พร้อมสคริปต์ AI", values: ["มี", "มี", "มี", "มี", "มี"] },
  { label: "ซับไทยอัตโนมัติ", values: ["มี", "มี", "มี", "มี", "มี"] },
  { label: "เพลงประกอบ", values: ["—", "มี", "มี", "มี", "มี"] },
  { label: "ไทม์ไลน์แก้มือ สลับช็อต และเรนเดอร์ซ้ำ", values: ["ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด"] },
  { label: "แปลงไฟล์อัตโนมัติเมื่อเบราว์เซอร์เปิดไม่ได้", values: ["—", "—", "มี", "มี", "มี"] },
  { label: "เก็บโปรเจกต์บนบัญชี เปิดต่อจากเครื่องอื่น", values: ["3 โปรเจกต์", "10 โปรเจกต์", "20 โปรเจกต์", "ไม่จำกัด", "ไม่จำกัด"], numeric: true },
  { label: "พื้นที่เก็บงานบนบัญชี", values: ["1 GB", "3 GB", "5 GB", "10 GB", "30 GB"], numeric: true },
  { label: "ลำดับคิวประมวลผล", values: ["ปกติ", "ปกติ", "ปกติ", "ก่อน", "แรกสุด"] },
];

/** Visible price label for a tier: "0" for free, formatted price, or null when unlisted. */
export function displayPrice(table: PriceTable, tier: Tier): string | null {
  if (tier === "free") return "0";
  const price = priceFor(table, tier);
  return price ? formatBaht(price.amountSatang) : null;
}
