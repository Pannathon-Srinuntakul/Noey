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
import { MODES } from "./modes";

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
// together. The budgets appear only in the calculator model below, as code:
// the site never prints a token count.
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

// ─── Cuts per mode at the visitor's own raw-clip length (/pricing) ──────────
//
// Owner, 2026-10-01: on /pricing a visitor picks the mode they cut in and how
// long their raw clips run, and every count on the page follows. ตัดฉากเด่น
// at 5 minutes stays the default and the basis every other surface states —
// the two maps above. The modes cost very differently: ตัดช่วงเงียบ only
// transcribes, ตัดไฮไลต์จากคลิปยาว reads the transcript and trims each
// highlight, ตัดฉากเด่น sends the footage itself.
//
// The arithmetic mirrors the backend and must stay exact:
// - ตัดฉากเด่น: `packages/billing/limits.py` `cut_tokens` (the fitted model
//   the two maps above come from; the fixed part includes the voiceover pass);
// - ตัดช่วงเงียบ and ตัดไฮไลต์จากคลิปยาว: `packages/billing/estimate.py`
//   `estimate_run` for `talking_head` / `speech_highlights`, with the
//   `rate_card.py` rates its speech model is charged at.
// A count is the plan's budget (`PlanLimits.monthly`; Free: its one-off
// credit) divided by one cut's cost, ROUNDED DOWN — 0 when one cut costs more
// than the whole budget. Only ตัดฉากเด่น has a footage ceiling per plan
// (`FOOTAGE_MINUTES`); the two speech modes take up to `SPEECH_FOOTAGE_MINUTES`
// on every plan and only the budget limits them (owner, 2026-10-01).
//
// The numbers below are rate-card tokens. They are code, never copy: the site
// never prints a token count, only the counts derived from them.
// plans.test.ts pins them against the backend's own results.

/**
 * The lengths the calculator offers, in whole minutes; `basis` is its
 * default. The longest is the mode's own (`maxClipMinutes`).
 */
export const CLIP_MINUTES = { min: 1, basis: 5 } as const;

/** The two analysis settings, by their identifiers (copy: `PRECISION_NAMES`). */
export type Precision = "standard" | "high";

/**
 * The three modes the site introduces (lib/modes.ts, same order), by the
 * editor's mode ids: ตัดช่วงเงียบ, ตัดฉากเด่น, ตัดไฮไลต์จากคลิปยาว.
 */
export type CutMode = "talking_head" | "dub_first" | "speech_highlights";
export const CUT_MODES: readonly CutMode[] = ["talking_head", "dub_first", "speech_highlights"];
/** The mode every count on the site is quoted in unless a visitor picks another. */
export const DEFAULT_CUT_MODE: CutMode = "dub_first";

/** Only ตัดฉากเด่น sends footage to the model, so only it has ระดับละเอียด. */
export function modeHasPrecision(mode: CutMode): boolean {
  return mode === "dub_first";
}

/** Each plan's budget for its window (Free: the one-off trial credit). */
const PLAN_BUDGET: Record<Tier, number> = {
  free: 450_000,
  lite: 800_000,
  starter: 2_000_000,
  pro: 5_600_000,
  studio: 12_000_000,
  agency: 26_000_000,
  max: 48_000_000,
};

/** ตัดฉากเด่น: per second of footage, per setting, plus the fixed part of a cut. */
const SCENE_PER_SEC: Record<Precision, number> = { standard: 65.6, high: 340.1 };
const SCENE_FIXED = 125_390 + 40_000;
/** Speech-to-text, per second of audio. */
const STT_PER_SEC = 51.75;
/** The speech model's input and output rates. */
const SPEECH_IN = 1.035;
const SPEECH_OUT = 5.175;
/** Transcript the highlight passes read, per second of audio. */
const TRANSCRIPT_PER_SEC = 15;
/** The highlight selector (one call) and the trim of each highlight it picks. */
const SELECTOR = { prompt: 4_000, output: 6_000 };
const TRIM = { prompt: 3_000, output: 2_500 };
/** Highlights a recording is priced for: one a minute, at least 3, at most 24. */
const PICK_SECONDS = 60;
const PICKS = { min: 3, max: 24 };

/** The rate card's rounding: snap float noise to 6 decimals, then round up. */
const cardCeil = (value: number) => Math.max(0, Math.ceil(Number(value.toFixed(6))));

/** Rate-card tokens one cut of `seconds` of raw clip costs in `mode`. */
export function cutCost(mode: CutMode, seconds: number, precision: Precision = "standard"): number {
  const stt = cardCeil(seconds * STT_PER_SEC);
  if (mode === "talking_head") return stt;
  if (mode === "speech_highlights") {
    const transcript = Math.ceil(TRANSCRIPT_PER_SEC * seconds);
    const picks = Math.max(PICKS.min, Math.min(PICKS.max, Math.ceil(seconds / PICK_SECONDS)));
    const selector = cardCeil((SELECTOR.prompt + transcript) * SPEECH_IN + SELECTOR.output * SPEECH_OUT);
    const trim = cardCeil((TRIM.prompt + Math.ceil(transcript / picks)) * SPEECH_IN + TRIM.output * SPEECH_OUT);
    return selector + trim * picks + stt;
  }
  return cardCeil(SCENE_PER_SEC[precision] * seconds) + SCENE_FIXED;
}

/** ตัดฉากเด่น's footage ceiling per project, in minutes — `FOOTAGE_PER_PROJECT` as numbers. */
export const FOOTAGE_MINUTES: Record<Tier, number> = {
  free: 10,
  lite: 10,
  starter: 20,
  pro: 30,
  studio: 30,
  agency: 30,
  max: 30,
};

/**
 * The footage ตัดช่วงเงียบ and ตัดไฮไลต์จากคลิปยาว take per project, on every
 * plan: the editor's own per-mode ceiling (web/src/lib/wizardState.ts
 * `capSecFor`, two hours).
 */
export const SPEECH_FOOTAGE_MINUTES = 120;

/** The longest raw clip the calculator offers in a mode: the largest plan's ceiling. */
export function maxClipMinutes(mode: CutMode = DEFAULT_CUT_MODE): number {
  return mode === "dub_first" ? Math.max(...Object.values(FOOTAGE_MINUTES)) : SPEECH_FOOTAGE_MINUTES;
}

/** A length the calculator accepts in `mode`: a whole number of minutes within its range. */
export function clampClipMinutes(minutes: number, mode: CutMode = DEFAULT_CUT_MODE): number {
  if (!Number.isFinite(minutes)) return CLIP_MINUTES.basis;
  return Math.min(maxClipMinutes(mode), Math.max(CLIP_MINUTES.min, Math.round(minutes)));
}

/**
 * How many cuts of a `minutes`-long raw clip the plan pays for per month
 * (Free: in all) in `mode`, rounded down — 0 when one cut is more than the
 * plan's whole budget. Null when the plan cannot take such a clip at all
 * (ตัดฉากเด่น past the plan's footage ceiling) or cannot pick that setting.
 */
export function cutsAt(
  tier: Tier,
  minutes: number,
  precision: Precision = "standard",
  mode: CutMode = DEFAULT_CUT_MODE,
): number | null {
  if (precision === "high" && (!modeHasPrecision(mode) || !hasHighPrecision(tier))) return null;
  const length = clampClipMinutes(minutes, mode);
  if (mode === "dub_first" && length > FOOTAGE_MINUTES[tier]) return null;
  return Math.floor(PLAN_BUDGET[tier] / cutCost(mode, length * 60, precision));
}

/** What /pricing says in place of a ตัดฉากเด่น count past the plan's footage ceiling. */
export const CUTS_OVER_FOOTAGE = "เกินเพดานฟุตเทจของแพลนนี้";
/** The same, short, for a table cell or a list. */
export const CUTS_OVER_FOOTAGE_SHORT = "เกินเพดานฟุตเทจ";
/** What it says where one clip of that length costs more than the plan's whole budget. */
export const CUTS_SHORT_OF_BUDGET = "ไม่พอสำหรับคลิปยาวขนาดนี้";
/** What a card's headline says when ระดับละเอียด is picked on a plan without it. */
export const CUTS_NO_FINE = "ไม่มีระดับละเอียด";

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
  "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที ปัดลง · คลิปที่ยาวกว่าหรือระดับละเอียดใช้โควตามากกว่า · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่";

/** A count as the page prints it: "3,091". */
export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * How a count reads in each mode. ตัดไฮไลต์จากคลิปยาว counts the LONG clips
 * that go in (each comes out as several short ones). Its estimate assumes up
 * to one highlight a minute, which is generous, but a run is charged per
 * request as it goes and can still exceed it — so the count is "ราว" like the
 * others, never a floor (owner's reviewer, 2026-10-01).
 */
export const CUT_MODE_WORDS: Record<CutMode, { hedge: string; unit: string }> = {
  talking_head: { hedge: CUTS_APPROX_SHORT, unit: "คลิป" },
  dub_first: { hedge: CUTS_APPROX_SHORT, unit: "คลิป" },
  speech_highlights: { hedge: CUTS_APPROX_SHORT, unit: "คลิปยาว" },
};

/**
 * The length the calculator starts a mode on, the first time it is picked
 * and as long as the visitor has not set one: a long clip is what
 * ตัดไฮไลต์จากคลิปยาว is for.
 */
export const DEFAULT_CLIP_MINUTES: Record<CutMode, number> = {
  talking_head: 5,
  dub_first: 5,
  speech_highlights: 30,
};

/** The mode's name as the editor and the home page spell it. */
export function cutModeName(mode: CutMode): string {
  return MODES.find((entry) => entry.id === mode)?.name ?? mode;
}

/**
 * The basis of a count, short: "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที", with
 * "ระดับละเอียด" after the mode when the count is at that setting.
 */
export function clipsBasis(minutes: number, mode: CutMode = DEFAULT_CUT_MODE, precision: Precision = "standard"): string {
  const setting = precision === "high" && modeHasPrecision(mode) ? ` ระดับ${PRECISION_NAMES.high}` : "";
  return `คิดจากโหมด${cutModeName(mode)}${setting} คลิปดิบ ${clampClipMinutes(minutes, mode)} นาที`;
}

/** What a count leaves out, per mode, after its basis. */
const CLIPS_CAVEAT: Record<CutMode, string> = {
  talking_head: "คลิปที่ยาวกว่าใช้โควตามากกว่า",
  dub_first: "คลิปที่ยาวกว่าหรือระดับละเอียดใช้โควตามากกว่า",
  speech_highlights: "หนึ่งคลิปยาวแยกได้หลายคลิปสั้น",
};

/**
 * Everything a count's footnote says after its basis: "ปัดลง · <caveat> ·
 * ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่". /pricing's calculator states
 * the basis beside its answer and this under the picker.
 */
export function clipsCaveats(mode: CutMode = DEFAULT_CUT_MODE): string {
  return `ปัดลง · ${CLIPS_CAVEAT[mode]} · ระบบบอกก่อนเริ่มทุกครั้งว่างานนี้ใช้เท่าไหร่`;
}

/**
 * The whole footnote for a count in `mode` at `minutes`. Every surface without
 * the calculator states `CLIPS_FOOTNOTE`, which is this at the default:
 * ตัดฉากเด่น, 5 minutes.
 */
export function clipsFootnote(minutes: number, mode: CutMode = DEFAULT_CUT_MODE): string {
  return `${clipsBasis(minutes, mode)} ${clipsCaveats(mode)}`;
}

/**
 * The plan the calculator answers with: the cheapest monthly plan whose count
 * covers `wanted` for this choice. Null when none does — the page then says
 * so rather than quietly pointing at the largest plan. Free is a one-off
 * trial credit, never the answer.
 */
export function fitTier(
  wanted: number,
  minutes: number,
  mode: CutMode = DEFAULT_CUT_MODE,
  precision: Precision = "standard",
): PaidTier | null {
  const setting = modeHasPrecision(mode) ? precision : "standard";
  return PAID_TIERS.find((tier) => (cutsAt(tier, minutes, setting, mode) ?? 0) >= Math.max(1, wanted)) ?? null;
}

/**
 * What a card puts under its own count — the basis, short, so a count read
 * alone is never ambiguous about the mode and length it assumes; the page
 * states the rest once. `clipsBasis` at the default.
 */
export const CLIPS_BASIS_SHORT = "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที";

/** The free plan's headline needs its own caption: it never comes back. */
export const FREE_CLIPS_CAPTION = "ทดลองใช้ครั้งเดียว ไม่รีเซ็ต";

// ─── Footage per project ─────────────────────────────────────────────────────
//
// Owner, 2026-09-29, narrowed 2026-10-01: the per-plan ceiling applies to
// ตัดฉากเด่น ONLY — the mode that hands the whole project to the AI in one
// video pass, so its footage is what the plan pays for. ตัดช่วงเงียบ and
// ตัดไฮไลต์จากคลิปยาว work from the transcript and take up to two hours on
// every plan (`SPEECH_FOOTAGE`, the editor's `capSecFor`); within that, the
// plan's quota is what limits a run. Every sentence that states the ladder
// therefore names ตัดฉากเด่น, and says the two hours for the others.
//
// ตัดฉากเด่น also has a ceiling of its own per request (1 hour at the
// ordinary setting / 44 minutes at the finer one); with every plan at 30
// minutes or less the plan's number is always the smaller, so it is not
// stated. If a plan ever exceeds 44 minutes again, bring it back. Mirrors the
// backend's `packages/billing/limits.py`; change both together or the site
// promises what the product refuses.
export const FOOTAGE_PER_PROJECT: Record<Tier, string> = {
  free: "10 นาที",
  lite: "10 นาที",
  starter: "20 นาที",
  pro: "30 นาที",
  studio: "30 นาที",
  agency: "30 นาที",
  max: "30 นาที",
};

/** The two speech modes' footage per project, on every plan (`SPEECH_FOOTAGE_MINUTES`). */
export const SPEECH_FOOTAGE = "2 ชั่วโมง";

/** The one statement of the speech modes' footage, so no page words its own. */
export const SPEECH_FOOTAGE_NOTE = `โหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาวรับฟุตเทจรวมได้ถึง ${SPEECH_FOOTAGE}ต่อโปรเจกต์ทุกแพลน`;

/** Feature/FAQ sentence listing ตัดฉากเด่น's ladder, so no page writes its own. */
export function footageLadderSentence(): string {
  return TIERS.map((tier) => `${PLAN_COPY[tier].name} ${FOOTAGE_PER_PROJECT[tier]}`).join(" · ");
}

/** A plan's footage bullet: "ฟุตเทจรวมโหมดตัดฉากเด่น 30 นาทีต่อโปรเจกต์". */
export function footageFeature(tier: Tier): string {
  return `ฟุตเทจรวมโหมดตัดฉากเด่น ${FOOTAGE_PER_PROJECT[tier]}ต่อโปรเจกต์`;
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
      footageFeature("free"),
      precisionFeature("free"),
      "ครบทุกโหมด รวมโหมดพากย์ใหม่",
      "เก็บได้ 3 โปรเจกต์ · 1 GB",
    ],
    accountFeatures: [
      `${clipsHeadline("free")} · ${FREE_CLIPS_CAPTION}`,
      `${footageFeature("free")} · ${precisionFeature("free")}`,
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
      footageFeature("lite"),
      precisionFeature("lite"),
      "เพิ่มเพลงประกอบได้",
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    accountFeatures: [
      clipsHeadline("lite"),
      `${footageFeature("lite")} · ${precisionFeature("lite")}`,
      "เก็บได้ 10 โปรเจกต์ · 3 GB",
    ],
    dialogSummary: `${clipsHeadline("lite")} · ฟุตเทจตัดฉากเด่น ${FOOTAGE_PER_PROJECT.lite}ต่อโปรเจกต์ · 3 GB`,
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
      footageFeature("starter"),
      precisionFeature("starter"),
      "ฟุตเทจยาวขึ้น พร้อมเพลงประกอบ",
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    accountFeatures: [
      clipsHeadline("starter"),
      `${footageFeature("starter")} · ${precisionFeature("starter")}`,
      "เก็บได้ 20 โปรเจกต์ · 5 GB",
    ],
    dialogSummary: `${clipsHeadline("starter")} · ฟุตเทจตัดฉากเด่น ${FOOTAGE_PER_PROJECT.starter}ต่อโปรเจกต์ · 5 GB`,
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
      footageFeature("pro"),
      precisionFeature("pro"),
      "ทำงาน AI พร้อมกันได้ 2 งาน",
      "คิวประมวลผลก่อนแพลนอื่น · จำนวนโปรเจกต์ไม่จำกัด ภายใน 10 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("pro"),
      `${footageFeature("pro")} · ${precisionFeature("pro")}`,
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
      footageFeature("studio"),
      precisionFeature("studio"),
      "ทำงาน AI พร้อมกันได้ 3 งาน",
      "คิวประมวลผลลำดับแรก · จำนวนโปรเจกต์ไม่จำกัด ภายใน 30 GB",
    ],
    accountFeatures: [
      clipsHeadlineFull("studio"),
      `${footageFeature("studio")} · ${precisionFeature("studio")}`,
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
      footageFeature("agency"),
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
      footageFeature("max"),
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

/** The free plan's count cell: one credit, not a month's. */
export const FREE_ONCE = "ครั้งเดียว";

/** Comparison table rows. Order follows TIERS (7 values each). */
type Row7 = readonly [string, string, string, string, string, string, string];

/**
 * A comparison row. `cuts` marks a clip-count row and its setting, so the
 * table can mark each cell for /pricing's calculator (its `values` are the
 * same counts at the default, as plain text).
 */
export interface ComparisonRow {
  label: string;
  values: Row7;
  numeric?: boolean;
  cuts?: Precision;
}

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    // The headline the whole product is sold on. The row label carries the
    // "ต่อเดือน (โดยประมาณ)", so each cell uses the compact form — but every
    // cell still says "ราว", because a cell read alone must not promise.
    label: "จำนวนคลิปต่อเดือน (โดยประมาณ)",
    values: TIERS.map((tier) =>
      tier === "free" ? `${clipsListItem(tier)} ${FREE_ONCE}` : clipsListItem(tier),
    ) as unknown as Row7,
    numeric: true,
    cuts: "standard",
  },
  {
    // Pro and up quote the finer setting's count too (owner, 2026-10-01);
    // below Pro the setting does not exist, so the cell says so rather than
    // repeating the ordinary count.
    label: `จำนวนคลิปต่อเดือน ระดับ${PRECISION_NAMES.high} (โดยประมาณ)`,
    values: TIERS.map((tier) => clipsHighListItem(tier) ?? "—") as unknown as Row7,
    numeric: true,
    cuts: "high",
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
    // The per-plan ceiling is ตัดฉากเด่น's alone (owner, 2026-10-01); the
    // row under it says what the two speech modes take on every plan.
    label: "ฟุตเทจรวมต่อโปรเจกต์ โหมดตัดฉากเด่น",
    values: TIERS.map((tier) => FOOTAGE_PER_PROJECT[tier]) as unknown as Row7,
    numeric: true,
  },
  {
    label: "ฟุตเทจรวมต่อโปรเจกต์ โหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาว",
    values: TIERS.map(() => SPEECH_FOOTAGE) as unknown as Row7,
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
