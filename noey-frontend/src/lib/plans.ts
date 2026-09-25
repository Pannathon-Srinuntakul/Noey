/**
 * Plan catalog + price handling.
 *
 * The COPY (names, blurbs, feature bullets, comparison rows) is the designer's
 * and is static. PRICES come from the backend's `GET /billing/plans`, with the
 * design's mock prices as the build-time fallback only. Both the visible page
 * and every machine-readable surface (JSON-LD offers, /pricing.md, /llms.txt)
 * render prices from the same `PriceTable`, so they cannot disagree.
 */

/** Every plan, cheapest first — the order of the comparison table. */
export const TIERS = ["free", "lite", "starter", "pro", "studio", "agency", "max"] as const;
export type Tier = (typeof TIERS)[number];

export const PAID_TIERS = ["lite", "starter", "pro", "studio", "agency", "max"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === "string" && (PAID_TIERS as readonly string[]).includes(value);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * The four plans shown as full cards (home strip and the top of /pricing).
 * Seven cards in one row is a wall; the others sit in a second, smaller row
 * (`EXTRA_TIERS`) and in the comparison table, which always lists all seven.
 */
export const MAIN_TIERS = ["free", "starter", "pro", "studio"] as const satisfies readonly Tier[];
export const EXTRA_TIERS = ["lite", "agency", "max"] as const satisfies readonly Tier[];

/** The backend's naming convention for Stripe price lookup keys. */
export function defaultLookupKey(tier: PaidTier): string {
  return `noey_${tier}_monthly`;
}

/**
 * Owner-approved ladder (THB / month, 2026-09-22) — used ONLY when the backend
 * is unreachable at build time. The backend catalog is the source of truth.
 */
export const FALLBACK_PRICES_THB: Record<PaidTier, number> = {
  lite: 199,
  starter: 399,
  pro: 990,
  studio: 1990,
  agency: 3990,
  max: 6990,
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
  /**
   * Usage relative to Lite (1x). Sold as a multiplier, never as a token
   * count — the user only ever sees percentages of their limits. null = free.
   */
  usageMultiplier: number | null;
  /** Which limit windows apply, by their English UI names. */
  limits: readonly UsageLimit[];
  /** AI jobs that may run at the same time; more queue. */
  concurrentJobs: number;
  /** Rough 5-minute-clip guide, always shown as approximate. */
  clipsApprox: string;
}

export type UsageLimit = "Monthly limit" | "Weekly limit" | "5-hour limit";

/** Shown next to every clip estimate: the guide depends on footage and mode. */
export const APPROX_NOTE = "โดยประมาณ ขึ้นกับความยาวและโหมด";

// ─── The ตัดฉากเด่น footage ceiling ──────────────────────────────────────────
//
// Every other mode reads the footage piece by piece, so the plan's
// "ฟุตเทจรวมต่อโปรเจกต์" is the only cap. ตัดฉากเด่น hands the WHOLE project to
// the AI in one pass, and how much one pass can read is fixed — a bigger plan
// does not move it. The higher ความละเอียด reads the same footage more densely,
// so it fills that pass sooner. Mirrors the backend's
// `packages/billing/limits.py:video_call_footage_sec` (owner, 2026-09-26);
// change both together or the site promises what the product refuses.

/** ตัดฉากเด่น at ความละเอียด Standard. */
export const SCENE_FOOTAGE_STANDARD = "1 ชั่วโมง";
/** ตัดฉากเด่น at ความละเอียด High — the same pass, read five times as densely. */
export const SCENE_FOOTAGE_HIGH = "44 นาที";

/** Comparison-table cell for the plans where the mode cap, not the plan, binds. */
const SCENE_ROW_PRO = `${SCENE_FOOTAGE_STANDARD} · High ${SCENE_FOOTAGE_HIGH}`;

/** Feature bullet for every plan whose 2-hour cap the ตัดฉากเด่น mode undercuts. */
const FOOTAGE_2H_FEATURE =
  `ฟุตเทจรวมสูงสุด 2 ชั่วโมงต่อโปรเจกต์ · โหมดตัดฉากเด่น ${SCENE_FOOTAGE_STANDARD} ` +
  `(ความละเอียด High ${SCENE_FOOTAGE_HIGH})`;

/** "5x" badge text, or null for the free plan. */
export function multiplierLabel(tier: Tier): string | null {
  const m = PLAN_COPY[tier].usageMultiplier;
  return m === null ? null : `${m}x`;
}

/** The sentence under the badge. */
export function multiplierCaption(tier: Tier): string {
  const m = PLAN_COPY[tier].usageMultiplier;
  if (m === null) return "สำหรับทดลองใช้";
  if (m === 1) return "ปริมาณการใช้งานพื้นฐาน";
  return `ปริมาณการใช้งาน ${m} เท่าของ Lite`;
}

export const PLAN_COPY: Record<Tier, PlanCopy> = {
  free: {
    tier: "free",
    name: "ฟรี",
    homeBlurb: "ลองระบบและตัดคลิปสั้นเป็นครั้งคราว",
    pricingBlurb: "ใช้ได้ต่อเนื่อง ไม่หมดอายุ",
    features: [
      "Monthly limit · ประมาณ 1–2 งานต่อเดือน จากฟุตเทจดิบ 5 นาที",
      "ฟุตเทจรวม 5 นาทีต่อโปรเจกต์",
      "ครบทุกโหมด รวมโหมดพากย์ใหม่",
      "เก็บได้ 3 โปรเจกต์ · 1 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 5 นาทีต่อโปรเจกต์", "เก็บได้ 3 โปรเจกต์ · 1 GB", "ครบทุกโหมด รวมโหมดพากย์ใหม่"],
    dialogSummary: "",
    pricingCta: "เริ่มใช้ฟรี",
    usageMultiplier: null,
    limits: ["Monthly limit"],
    concurrentJobs: 1,
    clipsApprox: "1–2 งาน/เดือน",
  },
  lite: {
    tier: "lite",
    name: "Lite",
    homeBlurb: "เริ่มแบบประหยัด ลงคลิปสัปดาห์ละไม่กี่ตัว",
    pricingBlurb: "เริ่มแบบประหยัด ลงคลิปสัปดาห์ละไม่กี่ตัว",
    features: [
      "Weekly limit · ประมาณ 3 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "ฟุตเทจรวม 10 นาทีต่อโปรเจกต์",
      "เพิ่มเพลงประกอบได้",
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 10 นาทีต่อโปรเจกต์", "เพิ่มเพลงประกอบได้", "เก็บได้ 10 โปรเจกต์ · 3 GB"],
    dialogSummary: "ใช้งาน 1x · ฟุตเทจ 10 นาทีต่อโปรเจกต์ · 3 GB",
    pricingCta: "เลือกแพลนนี้",
    usageMultiplier: 1,
    limits: ["Weekly limit"],
    concurrentJobs: 1,
    clipsApprox: "~3 งาน/สัปดาห์",
  },
  starter: {
    tier: "starter",
    name: "Starter",
    homeBlurb: "สำหรับคนที่ลงคลิปหลายตัวต่อสัปดาห์",
    pricingBlurb: "สำหรับคนที่ลงคลิปหลายตัวต่อสัปดาห์",
    features: [
      "Weekly limit · ประมาณ 6 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "ฟุตเทจรวม 20 นาทีต่อโปรเจกต์",
      "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ",
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    accountFeatures: ["ฟุตเทจรวม 20 นาทีต่อโปรเจกต์", "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ", "เก็บได้ 20 โปรเจกต์ · 5 GB"],
    dialogSummary: "ใช้งาน 2x · ฟุตเทจ 20 นาทีต่อโปรเจกต์ · 5 GB",
    pricingCta: "เลือกแพลนนี้",
    usageMultiplier: 2,
    limits: ["Weekly limit"],
    concurrentJobs: 1,
    clipsApprox: "~6 งาน/สัปดาห์",
  },
  pro: {
    tier: "pro",
    name: "Pro",
    homeBlurb: "ทำคลิปทุกวัน หรือรับงานให้ลูกค้าหลายเจ้า",
    pricingBlurb: "ทำคลิปทุกวัน หรือรับงานให้ลูกค้าหลายเจ้า",
    features: [
      "Weekly limit · ประมาณ 15 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "5-hour limit · ประมาณ 6 งานต่อรอบ 5 ชั่วโมง",
      "ทำงาน AI พร้อมกันได้ 2 งาน",
      FOOTAGE_2H_FEATURE,
      "คิวประมวลผลก่อนแพลนอื่น · จำนวนโปรเจกต์ไม่จำกัด ภายใน 10 GB",
    ],
    accountFeatures: [
      FOOTAGE_2H_FEATURE,
      "คิวประมวลผลก่อนแพลนอื่น",
      "เก็บโปรเจกต์ไม่จำกัดจำนวน · 10 GB",
    ],
    dialogSummary: `ใช้งาน 5x · ฟุตเทจสูงสุด 2 ชั่วโมง (ตัดฉากเด่น ${SCENE_FOOTAGE_STANDARD}) · 10 GB`,
    pricingCta: "เลือกแพลนนี้",
    recommended: true,
    usageMultiplier: 5,
    limits: ["Weekly limit", "5-hour limit"],
    concurrentJobs: 2,
    clipsApprox: "~15 งาน/สัปดาห์",
  },
  studio: {
    tier: "studio",
    name: "Studio",
    homeBlurb: "ผลิตคลิปวันละหลายตัว หรือรับงานเป็นทีม",
    pricingBlurb: "ผลิตคลิปวันละหลายตัว หรือรับงานเป็นทีม",
    features: [
      "Weekly limit · ประมาณ 30 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "5-hour limit · ประมาณ 12 งานต่อรอบ 5 ชั่วโมง",
      "ทำงาน AI พร้อมกันได้ 3 งาน",
      FOOTAGE_2H_FEATURE,
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 30 GB",
    ],
    accountFeatures: [FOOTAGE_2H_FEATURE, "คิวประมวลผลลำดับแรก", "เก็บโปรเจกต์ไม่จำกัด · 30 GB"],
    dialogSummary: "ใช้งาน 10x · ทำงานพร้อมกัน 3 งาน · 30 GB",
    pricingCta: "เลือกแพลนนี้",
    usageMultiplier: 10,
    limits: ["Weekly limit", "5-hour limit"],
    concurrentJobs: 3,
    clipsApprox: "~30 งาน/สัปดาห์",
  },
  agency: {
    tier: "agency",
    name: "Agency",
    homeBlurb: "ดูแลหลายแบรนด์พร้อมกัน",
    pricingBlurb: "สำหรับเอเจนซีที่ดูแลคอนเทนต์หลายแบรนด์",
    features: [
      "Weekly limit · ประมาณ 60 งานต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "5-hour limit · ประมาณ 24 งานต่อรอบ 5 ชั่วโมง",
      "ทำงาน AI พร้อมกันได้ 4 งาน",
      FOOTAGE_2H_FEATURE,
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 60 GB",
    ],
    accountFeatures: ["ทำงาน AI พร้อมกันได้ 4 งาน", "คิวประมวลผลลำดับแรก", "เก็บโปรเจกต์ไม่จำกัด · 60 GB"],
    dialogSummary: "ใช้งาน 20x · ทำงานพร้อมกัน 4 งาน · 60 GB",
    pricingCta: "เลือกแพลนนี้",
    usageMultiplier: 20,
    limits: ["Weekly limit", "5-hour limit"],
    concurrentJobs: 4,
    clipsApprox: "~60 งาน/สัปดาห์",
  },
  max: {
    tier: "max",
    name: "Max",
    homeBlurb: "ทีมผลิตคอนเทนต์เต็มเวลา ใช้งานต่อเนื่องได้ทั้งวัน",
    pricingBlurb: "สำหรับทีมผลิตคอนเทนต์เต็มเวลา ใช้งานต่อเนื่องได้ทั้งวัน",
    features: [
      "Weekly limit · ประมาณ 100 งานขึ้นไปต่อสัปดาห์ จากฟุตเทจดิบ 5 นาที",
      "5-hour limit · ประมาณ 40 งานต่อรอบ 5 ชั่วโมง",
      "ทำงาน AI พร้อมกันได้ 5 งาน",
      FOOTAGE_2H_FEATURE,
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 100 GB",
    ],
    accountFeatures: ["ทำงาน AI พร้อมกันได้ 5 งาน", "คิวประมวลผลลำดับแรก", "เก็บโปรเจกต์ไม่จำกัด · 100 GB"],
    dialogSummary: "ใช้งาน 35x · ทำงานพร้อมกัน 5 งาน · 100 GB",
    pricingCta: "เลือกแพลนนี้",
    usageMultiplier: 35,
    limits: ["Weekly limit", "5-hour limit"],
    concurrentJobs: 5,
    clipsApprox: "100+ งาน/สัปดาห์",
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

/** "Weekly + 5-hour" — the table's short form of a plan's limit windows. */
export function limitsShort(limits: readonly UsageLimit[]): string {
  if (limits.length === 1) return limits[0];
  return limits.map((limit) => limit.replace(" limit", "")).join(" + ");
}

/** Comparison table rows. Order follows TIERS (7 values each). */
type Row7 = readonly [string, string, string, string, string, string, string];

export const COMPARISON_ROWS: ReadonlyArray<{ label: string; values: Row7; numeric?: boolean }> = [
  {
    label: "ปริมาณการใช้งาน (เทียบกับ Lite)",
    values: TIERS.map((tier) => multiplierLabel(tier) ?? "ทดลองใช้") as unknown as Row7,
    numeric: true,
  },
  {
    label: "ขีดจำกัดการใช้งาน",
    values: TIERS.map((tier) => limitsShort(PLAN_COPY[tier].limits)) as unknown as Row7,
  },
  {
    label: `จำนวนงาน เมื่อฟุตเทจดิบยาว 5 นาที (${APPROX_NOTE})`,
    values: TIERS.map((tier) => PLAN_COPY[tier].clipsApprox) as unknown as Row7,
    numeric: true,
  },
  {
    label: "งาน AI ที่ทำพร้อมกันได้",
    values: TIERS.map((tier) => `${PLAN_COPY[tier].concurrentJobs} งาน`) as unknown as Row7,
    numeric: true,
  },
  { label: "ฟุตเทจรวมต่อโปรเจกต์", values: ["5 นาที", "10 นาที", "20 นาที", "2 ชั่วโมง", "2 ชั่วโมง", "2 ชั่วโมง", "2 ชั่วโมง"], numeric: true },
  {
    // A row of its own, not a footnote on the one above: from Pro up the two
    // numbers differ, and someone comparing plans has to see that this one
    // stops climbing. Below Pro the plan's cap is the shorter of the two, so
    // the cell repeats it and ความละเอียด changes nothing.
    label: "ฟุตเทจรวมต่อโปรเจกต์ · โหมดตัดฉากเด่น",
    values: [
      "5 นาที",
      "10 นาที",
      "20 นาที",
      SCENE_ROW_PRO,
      SCENE_ROW_PRO,
      SCENE_ROW_PRO,
      SCENE_ROW_PRO,
    ],
  },
  { label: "โหมดเก็บทุกฉาก และโหมดไฮไลต์", values: ["มี", "มี", "มี", "มี", "มี", "มี", "มี"] },
  { label: "โหมดพากย์ใหม่ พร้อมสคริปต์ AI", values: ["มี", "มี", "มี", "มี", "มี", "มี", "มี"] },
  { label: "ซับไทยอัตโนมัติ", values: ["มี", "มี", "มี", "มี", "มี", "มี", "มี"] },
  { label: "เพลงประกอบ", values: ["—", "มี", "มี", "มี", "มี", "มี", "มี"] },
  { label: "ไทม์ไลน์แก้มือ สลับช็อต และเรนเดอร์ซ้ำ", values: ["ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด", "ไม่จำกัด"] },
  { label: "แปลงไฟล์อัตโนมัติเมื่อเบราว์เซอร์เปิดไม่ได้", values: ["—", "—", "มี", "มี", "มี", "มี", "มี"] },
  { label: "จำนวนโปรเจกต์ที่เก็บบนบัญชี (ภายในพื้นที่ที่ได้)", values: ["3 โปรเจกต์", "10 โปรเจกต์", "20 โปรเจกต์", "ไม่จำกัดจำนวน", "ไม่จำกัดจำนวน", "ไม่จำกัดจำนวน", "ไม่จำกัดจำนวน"], numeric: true },
  { label: "พื้นที่เก็บงานบนบัญชี", values: ["1 GB", "3 GB", "5 GB", "10 GB", "30 GB", "60 GB", "100 GB"], numeric: true },
  { label: "ลำดับคิวประมวลผล", values: ["ปกติ", "ปกติ", "ปกติ", "ก่อน", "แรก", "แรก", "แรก"] },
];

/** Visible price label for a tier: "0" for free, formatted price, or null when unlisted. */
export function displayPrice(table: PriceTable, tier: Tier): string | null {
  if (tier === "free") return "0";
  const price = priceFor(table, tier);
  return price ? formatBaht(price.amountSatang) : null;
}
