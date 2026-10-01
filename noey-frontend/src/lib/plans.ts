/**
 * Plan catalog + price handling.
 *
 * The COPY (names, blurbs, feature bullets, comparison rows) is the designer's
 * and is static. PRICES come from the backend's `GET /billing/plans`, with the
 * design's mock prices as the build-time fallback only. Both the visible page
 * and every machine-readable surface (JSON-LD offers, /pricing.md, /llms.txt)
 * render prices from the same `PriceTable`, so they cannot disagree.
 *
 * During the beta (see `beta.ts`) the backend/Stripe price IS the discounted
 * one — there is no coupon. The full price is the static ladder below and is
 * only ever drawn struck through; after `BETA_END_DATE_ISO` nothing is struck
 * and the full ladder is what the backend charges.
 */
import { isBetaActive } from "./beta";

/**
 * Every plan, cheapest first — the order of the comparison table.
 *
 * These seven words are RESERVED for plans and may never also name an AI
 * model. Until 2026-09-30 the editor's model dial offered "Lite" and "Pro",
 * so on one screen "Pro" meant both a plan and a model and a Lite-plan
 * customer could pick the "Pro" model — a contradiction that would have
 * arrived as a support ticket. The dial was renamed to a ladder of its own,
 * Scout → Director, with Auteur reserved for a rung above and Cutter for one
 * between. If a model ever needs a name here, take it from that ladder; never
 * from this list.
 */
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
 * Owner-approved full ladder (THB / month, 2026-09-22). From 1 Jan 2027 this
 * is what every account is billed; until then it is the struck-through number
 * beside the beta price.
 */
export const FULL_PRICES_THB: Record<PaidTier, number> = {
  lite: 199,
  starter: 399,
  pro: 990,
  studio: 1990,
  agency: 3990,
  max: 6990,
};

/**
 * The beta ladder (owner, 2026-09-29): half of the full price, rounded to a
 * number ending in 9. This is the amount actually charged while the beta runs
 * — it is the Stripe price, not a discount applied on top of one.
 *
 * Starter's 199 equals Lite's full 199 on purpose. The two never sit side by
 * side because Lite lives in the "แพลนเพิ่มเติม" row (`EXTRA_TIERS`), and the
 * colliding number is a struck-through one that nobody pays.
 */
export const BETA_PRICES_THB: Record<PaidTier, number> = {
  lite: 99,
  starter: 199,
  pro: 499,
  studio: 999,
  agency: 1999,
  max: 3499,
};

/** What the backend is expected to charge at `now` — beta ladder, then full. */
export function chargedPricesThb(now: Date | number = Date.now()): Record<PaidTier, number> {
  return isBetaActive(now) ? BETA_PRICES_THB : FULL_PRICES_THB;
}

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

export function fallbackPriceTable(now: Date | number = Date.now()): PriceTable {
  const ladder = chargedPricesThb(now);
  const prices: Partial<Record<PaidTier, PaidPrice>> = {};
  for (const tier of PAID_TIERS) {
    prices[tier] = { amountSatang: ladder[tier] * 100, lookupKey: defaultLookupKey(tier) };
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
  /**
   * Bullet list on /pricing. It never repeats the clip count — the card's
   * headline states that, with `CLIPS_FOOTNOTE` under it.
   */
  features: readonly string[];
  /** Bullets on the account billing card (design shows the free-plan version). */
  accountFeatures: readonly string[];
  /** One-line summary inside the upgrade dialog. */
  dialogSummary: string;
  /** Button label on /pricing. */
  pricingCta: string;
  recommended?: boolean;
  /** Which limit windows apply, by their English UI names. */
  limits: readonly UsageLimit[];
  /** AI jobs that may run at the same time; more queue. */
  concurrentJobs: number;
}

export type UsageLimit = "Trial credit" | "Monthly limit" | "Weekly limit" | "5-hour limit";

// ─── Approximate cuts per month — the headline on every card ─────────────────
//
// Owner, 2026-09-29. The product is sold in CLIPS, not in minutes: what a cut
// costs is dominated by a fixed per-run cost rather than by the footage, so a
// long source is barely dearer than a short one. Minutes described something
// the user does not care about. Every surface derives its count from this one
// map — cards, comparison table, FAQ, guides, /pricing.md, /llms.txt.
//
// APPROX, and the name says so on purpose: an ordinary cut and a long
// high-precision one differ by about four times, so this number is a guide,
// never a balance. NOTHING may subtract from it, and no meter may count down
// in cuts — a single heavy upload would drop it by four. Quota is shown as a
// percentage, everywhere, always (owner's standing decision).
//
// Free is NOT a monthly allowance: it is one trial credit, spent once.
//
// HONEST since 2026-10-01 (owner): each figure is the plan's monthly budget
// divided by what a 5-minute raw clip actually costs under the fitted
// production model, ROUNDED DOWN — never rounded up, never a hand-picked
// round number. Standard (ระดับปกติ) = 185,070 rate-card tokens per cut,
// High (ระดับละเอียด) = 267,420. The backend derives the same numbers in
// `packages/billing/limits.py` (`plan_cuts` / `plan_cuts_high`, served as
// `approx_cuts` / `approx_cuts_high`) and its tests pin them; change both
// together. Budgets are not written here on purpose: the site never states a
// token count.
export const APPROX_CUTS_PER_MONTH: Record<Tier, number> = {
  free: 2,
  lite: 4,
  starter: 10,
  pro: 30,
  studio: 64,
  agency: 140,
  max: 259,
};

/**
 * The same count at ระดับละเอียด, for the plans that can pick it (Pro and
 * up). A plan bought FOR its finer setting must not quote only the ordinary
 * count, so every surface that states a Pro+ count states this one too.
 */
export const APPROX_HIGH_CUTS_PER_MONTH: Partial<Record<Tier, number>> = {
  pro: 20,
  studio: 44,
  agency: 97,
  max: 179,
};

/**
 * The word that makes the number honest. Load-bearing: without it the card
 * states a quota the product cannot guarantee for a heavy user.
 */
export const CUTS_APPROX_PREFIX = "ตัดได้ราว";
/** The bare hedge, for the free plan's one-off credit and for enumerations. */
export const CUTS_APPROX_SHORT = "ราว";

/** The headline itself: "ตัดได้ราว 30 คลิป/เดือน", or the free plan's one-off credit. */
export function clipsHeadline(tier: Tier): string {
  const cuts = APPROX_CUTS_PER_MONTH[tier];
  return tier === "free" ? `${CUTS_APPROX_SHORT} ${cuts} คลิป` : `${CUTS_APPROX_PREFIX} ${cuts} คลิป/เดือน`;
}

/** The ระดับละเอียด count as a phrase — "ระดับละเอียดราว 20 คลิป" — or null below Pro. */
export function clipsHighLine(tier: Tier): string | null {
  const cuts = APPROX_HIGH_CUTS_PER_MONTH[tier];
  return cuts ? `ระดับ${PRECISION_NAMES.high}${CUTS_APPROX_SHORT} ${cuts} คลิป` : null;
}

/**
 * Both counts in one line — "ตัดได้ราว 30 คลิป/เดือน · ระดับละเอียดราว 20
 * คลิป" — for a surface that has room for only one line per plan (account
 * card, upgrade dialog). Lite/Starter/Free get the headline alone.
 */
export function clipsHeadlineFull(tier: Tier): string {
  const high = clipsHighLine(tier);
  return high ? `${clipsHeadline(tier)} · ${high}` : clipsHeadline(tier);
}

/**
 * Compact form for a list whose lead already said "ต่อเดือน". It keeps "ราว"
 * per item on purpose: an agent may quote one item out of the list, and a bare
 * number there would be a promise. The ordinary count only — the comparison
 * table carries the finer one in its own row.
 */
export function clipsListItem(tier: Tier): string {
  return `${CUTS_APPROX_SHORT} ${APPROX_CUTS_PER_MONTH[tier]} คลิป`;
}

/** The ระดับละเอียด count in the same compact form, or null below Pro. */
export function clipsHighListItem(tier: Tier): string | null {
  const cuts = APPROX_HIGH_CUTS_PER_MONTH[tier];
  return cuts ? `${CUTS_APPROX_SHORT} ${cuts} คลิป` : null;
}

/**
 * "Lite ราว 4 คลิป · … · Pro ราว 30 คลิป (ระดับละเอียดราว 20 คลิป) · …" —
 * the ladder, written once, with both counts wherever the plan has both.
 */
export function clipsLadderSentence(tiers: readonly Tier[] = TIERS): string {
  return tiers
    .map((tier) => {
      const high = clipsHighLine(tier);
      return `${PLAN_COPY[tier].name} ${clipsListItem(tier)}${high ? ` (${high})` : ""}`;
    })
    .join(" · ");
}

/**
 * The volume discount in words (owner, 2026-10-01): bigger plans buy each
 * clip for less. Stated as a fact about the ladder, never as a baht figure —
 * the price per clip moves with the beta ladder and the site does not quote it.
 */
export const VOLUME_VALUE_NOTE = "แพลนใหญ่ขึ้น ได้คลิปต่อบาทมากขึ้น";

/**
 * The basis of every clip count. A count with no basis is a promise the product
 * breaks; the third clause is the one that keeps it honest — the app prices a
 * run before it starts, so nobody is surprised afterwards.
 *
 * Printed ONCE per page, under the grid (owner, 2026-09-29: seven copies on
 * /pricing was noise). Individual cards carry `CLIPS_BASIS_SHORT` instead. The
 * machine-readable surfaces repeat the full sentence per plan on purpose —
 * repetition is free there, and an agent may read one plan in isolation.
 */
export const CLIPS_FOOTNOTE =
  "คิดจากคลิปดิบ 5 นาที ปัดลง · คลิปที่ยาวกว่าหรือระดับละเอียดใช้โควตามากกว่า · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่";

/** What a card puts under its own count; the page states the rest once. */
export const CLIPS_BASIS_SHORT = "~คลิปดิบ 5 นาที";

/** The free plan's headline needs its own caption: it never comes back. */
export const FREE_CLIPS_CAPTION = "ทดลองใช้ครั้งเดียว ไม่รีเซ็ต";

// ─── Footage per project ─────────────────────────────────────────────────────
//
// Owner, 2026-09-29. ONE number per plan, and it is the only footage ceiling
// the site states. The earlier copy promised Pro and up "2 ชั่วโมง" and then
// had to qualify it with the ตัดฉากเด่น mode's own ceiling (1 hour at the
// ordinary setting / 44 minutes at the finer one, which that mode hits
// because it hands the whole project to
// the AI in one pass). With every plan now at 30 minutes or less, the plan's
// number is always the smaller of the two, so the mode ceiling can never bind
// and stating it would only be noise. If a plan ever exceeds 44 minutes again,
// bring the second number back. Mirrors the backend's
// `packages/billing/limits.py`; change both together or the site promises what
// the product refuses.
export const FOOTAGE_PER_PROJECT: Record<Tier, string> = {
  free: "10 นาที",
  lite: "10 นาที",
  starter: "20 นาที",
  pro: "30 นาที",
  studio: "30 นาที",
  agency: "30 นาที",
  max: "30 นาที",
};

/** Feature/FAQ sentence listing the whole ladder, so no page writes its own. */
export function footageLadderSentence(): string {
  return TIERS.map((tier) => `${PLAN_COPY[tier].name} ${FOOTAGE_PER_PROJECT[tier]}`).join(" · ");
}

// ─── ความละเอียด (analysis precision) ────────────────────────────────────────
//
// Owner, 2026-09-29: Free, Lite and Starter get the ordinary setting only; the
// finer one is a Pro-and-up feature. It costs several times the per-second
// rate, which on the cheap plans would silently halve the clip count, so it is
// sold as a visible tier feature instead of a hidden tax. Describe it as
// denser, sharper cuts — never by naming a model or a frame rate. The site must
// not advertise the finer setting to a plan that cannot select it.
//
// The two settings are named in Thai, 2026-09-30, because the editor's dial now
// reads ปกติ / ละเอียด. The earlier English "Standard / High" was chosen when
// the dial itself said Standard and High; it does not any more, and a customer
// must not have to translate the price page into the product. The English
// spelling survives only in `HIGH_PRECISION_TIERS` and the code around it,
// where it is an identifier, not copy. Prose says ระดับปกติ / ระดับละเอียด;
// the comparison-table cell says the bare word the dial shows.
export const HIGH_PRECISION_TIERS: readonly Tier[] = ["pro", "studio", "agency", "max"];

/** The two settings exactly as the editor's dial spells them. */
export const PRECISION_NAMES = { standard: "ปกติ", high: "ละเอียด" } as const;

export function hasHighPrecision(tier: Tier): boolean {
  return HIGH_PRECISION_TIERS.includes(tier);
}

/** Comparison-table cell and feature bullet for the precision tiers a plan gets. */
export function precisionLabel(tier: Tier): string {
  return hasHighPrecision(tier)
    ? `${PRECISION_NAMES.standard} และ ${PRECISION_NAMES.high}`
    : PRECISION_NAMES.standard;
}

/** Feature bullet describing what a plan's precision buys. */
export function precisionFeature(tier: Tier): string {
  return hasHighPrecision(tier)
    ? `วิเคราะห์ระดับ${PRECISION_NAMES.high} ตัดถี่ขึ้น จุดตัดแม่นขึ้น`
    : `วิเคราะห์ระดับ${PRECISION_NAMES.standard}`;
}

export const PLAN_COPY: Record<Tier, PlanCopy> = {
  free: {
    tier: "free",
    name: "ฟรี",
    homeBlurb: "เครดิตทดลองก้อนเดียว ไว้ลองตัดคลิปแรก",
    // Not a recurring 0-baht plan: one credit, spent once, then you upgrade.
    pricingBlurb: "ทดลองใช้ครั้งเดียว ใช้หมดแล้วเลือกแพลนต่อ",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.free}ต่อโปรเจกต์`,
      precisionFeature("free"),
      "ครบทุกโหมด รวมโหมดพากย์ใหม่",
      "เก็บได้ 3 โปรเจกต์ · 1 GB",
    ],
    accountFeatures: [
      `${clipsHeadline("free")} · ${FREE_CLIPS_CAPTION}`,
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.free}ต่อโปรเจกต์ · ${precisionFeature("free")}`,
      "เก็บได้ 3 โปรเจกต์ · 1 GB",
    ],
    dialogSummary: "",
    pricingCta: "เริ่มใช้ฟรี",
    limits: ["Trial credit"],
    concurrentJobs: 1,
  },
  lite: {
    tier: "lite",
    name: "Lite",
    homeBlurb: "เริ่มแบบประหยัด ลงคลิปสัปดาห์ละไม่กี่ตัว",
    pricingBlurb: "เริ่มแบบประหยัด ลงคลิปสัปดาห์ละไม่กี่ตัว",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.lite}ต่อโปรเจกต์`,
      precisionFeature("lite"),
      "เพิ่มเพลงประกอบได้",
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    accountFeatures: [
      clipsHeadline("lite"),
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.lite}ต่อโปรเจกต์ · ${precisionFeature("lite")}`,
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    dialogSummary: `${clipsHeadline("lite")} · ฟุตเทจ ${FOOTAGE_PER_PROJECT.lite}ต่อโปรเจกต์ · 3 GB`,
    pricingCta: "เลือกแพลนนี้",
    limits: ["Monthly limit"],
    concurrentJobs: 1,
  },
  starter: {
    tier: "starter",
    name: "Starter",
    homeBlurb: "สำหรับคนที่ลงคลิปหลายตัวต่อสัปดาห์",
    pricingBlurb: "สำหรับคนที่ลงคลิปหลายตัวต่อสัปดาห์",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.starter}ต่อโปรเจกต์`,
      precisionFeature("starter"),
      "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ",
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    accountFeatures: [
      clipsHeadline("starter"),
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.starter}ต่อโปรเจกต์ · ${precisionFeature("starter")}`,
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    dialogSummary: `${clipsHeadline("starter")} · ฟุตเทจ ${FOOTAGE_PER_PROJECT.starter}ต่อโปรเจกต์ · 5 GB`,
    pricingCta: "เลือกแพลนนี้",
    limits: ["Monthly limit"],
    concurrentJobs: 1,
  },
  pro: {
    tier: "pro",
    name: "Pro",
    homeBlurb: "ทำคลิปทุกวัน หรือรับงานให้ลูกค้าหลายเจ้า",
    pricingBlurb: "ทำคลิปทุกวัน หรือรับงานให้ลูกค้าหลายเจ้า",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.pro}ต่อโปรเจกต์`,
      precisionFeature("pro"),
      "ทำงาน AI พร้อมกันได้ 2 งาน",
      "คิวประมวลผลก่อนแพลนอื่น · จำนวนโปรเจกต์ไม่จำกัด ภายใน 10 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("pro"),
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.pro}ต่อโปรเจกต์ · ${precisionFeature("pro")}`,
      "คิวประมวลผลก่อนแพลนอื่น · เก็บโปรเจกต์ไม่จำกัดจำนวน · 10 GB",
    ],
    dialogSummary: `${clipsHeadlineFull("pro")} · 10 GB`,
    pricingCta: "เลือกแพลนนี้",
    recommended: true,
    limits: ["Monthly limit"],
    concurrentJobs: 2,
  },
  studio: {
    tier: "studio",
    name: "Studio",
    homeBlurb: "ผลิตคลิปวันละหลายตัว หรือรับงานเป็นทีม",
    pricingBlurb: "ผลิตคลิปวันละหลายตัว หรือรับงานเป็นทีม",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.studio}ต่อโปรเจกต์`,
      precisionFeature("studio"),
      "ทำงาน AI พร้อมกันได้ 3 งาน",
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 30 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("studio"),
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.studio}ต่อโปรเจกต์ · ${precisionFeature("studio")}`,
      "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 30 GB",
    ],
    dialogSummary: `${clipsHeadlineFull("studio")} · ทำงานพร้อมกัน 3 งาน · 30 GB`,
    pricingCta: "เลือกแพลนนี้",
    limits: ["Monthly limit"],
    concurrentJobs: 3,
  },
  agency: {
    tier: "agency",
    name: "Agency",
    homeBlurb: "ดูแลหลายแบรนด์พร้อมกัน",
    pricingBlurb: "สำหรับเอเจนซีที่ดูแลคอนเทนต์หลายแบรนด์",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.agency}ต่อโปรเจกต์`,
      precisionFeature("agency"),
      "ทำงาน AI พร้อมกันได้ 4 งาน",
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 60 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("agency"),
      "ทำงาน AI พร้อมกันได้ 4 งาน",
      "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 60 GB",
    ],
    dialogSummary: `${clipsHeadlineFull("agency")} · ทำงานพร้อมกัน 4 งาน · 60 GB`,
    pricingCta: "เลือกแพลนนี้",
    limits: ["Monthly limit"],
    concurrentJobs: 4,
  },
  max: {
    tier: "max",
    name: "Max",
    homeBlurb: "ทีมผลิตคอนเทนต์เต็มเวลา ใช้งานต่อเนื่องได้ทั้งวัน",
    pricingBlurb: "สำหรับทีมผลิตคอนเทนต์เต็มเวลา ใช้งานต่อเนื่องได้ทั้งวัน",
    features: [
      `ฟุตเทจรวม ${FOOTAGE_PER_PROJECT.max}ต่อโปรเจกต์`,
      precisionFeature("max"),
      "ทำงาน AI พร้อมกันได้ 5 งาน",
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 100 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("max"),
      "ทำงาน AI พร้อมกันได้ 5 งาน",
      "คิวประมวลผลลำดับแรก · เก็บโปรเจกต์ไม่จำกัด · 100 GB",
    ],
    dialogSummary: `${clipsHeadlineFull("max")} · ทำงานพร้อมกัน 5 งาน · 100 GB`,
    pricingCta: "เลือกแพลนนี้",
    limits: ["Monthly limit"],
    concurrentJobs: 5,
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
    // The headline the whole product is sold on. The row label carries the
    // "ต่อเดือน (โดยประมาณ)", so each cell uses the compact form — but every
    // cell still says "ราว", because a cell read alone must not promise.
    label: "จำนวนคลิปต่อเดือน (โดยประมาณ)",
    values: TIERS.map((tier) =>
      tier === "free" ? `${clipsListItem(tier)} ครั้งเดียว` : clipsListItem(tier),
    ) as unknown as Row7,
    numeric: true,
  },
  {
    // Pro and up quote the finer setting's count too (owner, 2026-10-01);
    // below Pro the setting does not exist, so the cell says so rather than
    // repeating the ordinary count.
    label: `จำนวนคลิปต่อเดือน ระดับ${PRECISION_NAMES.high} (โดยประมาณ)`,
    values: TIERS.map((tier) => clipsHighListItem(tier) ?? "—") as unknown as Row7,
    numeric: true,
  },
  {
    label: "ขีดจำกัดการใช้งาน",
    values: TIERS.map((tier) => limitsShort(PLAN_COPY[tier].limits)) as unknown as Row7,
  },
  {
    label: "งาน AI ที่ทำพร้อมกันได้",
    values: TIERS.map((tier) => `${PLAN_COPY[tier].concurrentJobs} งาน`) as unknown as Row7,
    numeric: true,
  },
  {
    label: "ฟุตเทจรวมต่อโปรเจกต์",
    values: TIERS.map((tier) => FOOTAGE_PER_PROJECT[tier]) as unknown as Row7,
    numeric: true,
  },
  {
    // Free, Lite and Starter get the ordinary setting only (owner,
    // 2026-09-29), so the site must not advertise the finer one to them.
    label: "ความละเอียดการวิเคราะห์",
    values: TIERS.map((tier) => precisionLabel(tier)) as unknown as Row7,
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

/**
 * Is the backend actually charging the beta ladder? The date alone is not
 * enough: the prices come from `GET /billing/plans`, so until that catalog is
 * switched over, claiming a discount beside an undiscounted number would be a
 * lie. Every beta PRICE claim asks this; the beta programme's own banner and
 * modal ask only the date.
 */
/**
 * The full price to draw struck through immediately before the beta price, or
 * null when there is nothing to strike — the beta is over, the plan is free or
 * unlisted, or the backend is already charging the full amount (in which case
 * "1,990 1,990" would be nonsense).
 *
 * This is the whole reversion mechanism on the price itself: once
 * `BETA_END_DATE_ISO` passes, every card stops striking anything on the next
 * revalidation, with no deploy.
 */
export function isBetaPriced(table: PriceTable, now: Date | number = Date.now()): boolean {
  return PAID_TIERS.some((tier) => strikePrice(table, tier, now) !== null);
}

export function strikePrice(table: PriceTable, tier: Tier, now: Date | number = Date.now()): string | null {
  if (!isBetaActive(now)) return null;
  if (!isPaidTier(tier)) return null;
  const charged = priceFor(table, tier);
  if (!charged) return null;
  const fullSatang = FULL_PRICES_THB[tier] * 100;
  if (charged.amountSatang >= fullSatang) return null;
  return formatBaht(fullSatang);
}
