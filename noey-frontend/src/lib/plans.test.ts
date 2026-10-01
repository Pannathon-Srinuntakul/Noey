import { describe, expect, it } from "vitest";
import { BETA_END_INSTANT_MS } from "./beta";
import {
  BETA_PRICES_THB,
  APPROX_CUTS_PER_MONTH,
  APPROX_HIGH_CUTS_PER_MONTH,
  CLIPS_FOOTNOTE,
  COMPARISON_ROWS,
  EXTRA_TIERS,
  FOOTAGE_PER_PROJECT,
  FREE_CLIPS_CAPTION,
  FULL_PRICES_THB,
  MAIN_TIERS,
  PAID_TIERS,
  PLAN_COPY,
  TIERS,
  clipsHeadline,
  clipsHeadlineFull,
  clipsHighLine,
  clipsHighListItem,
  clipsLadderSentence,
  clipsListItem,
  displayPrice,
  fallbackPriceTable,
  footageLadderSentence,
  formatBaht,
  hasHighPrecision,
  isBetaPriced,
  lookupKeyFor,
  lowestPaidPrice,
  normalizePlansResponse,
  planDisplayName,
  PRECISION_NAMES,
  precisionFeature,
  precisionLabel,
  schemaPrice,
  strikePrice,
  tierFromLookupKey,
} from "./plans";

/** A moment inside the beta, and the first moment after it. */
const DURING_BETA = BETA_END_INSTANT_MS - 1;
const AFTER_BETA = BETA_END_INSTANT_MS;

describe("formatBaht", () => {
  it("formats whole baht with en-US grouping like the design", () => {
    expect(formatBaht(19000)).toBe("190");
    expect(formatBaht(189000)).toBe("1,890");
    expect(formatBaht(0)).toBe("0");
  });

  it("keeps two decimals for fractional baht", () => {
    expect(formatBaht(19050)).toBe("190.50");
    expect(formatBaht(123456789)).toBe("1,234,567.89");
  });
});

describe("schemaPrice", () => {
  it("emits plain decimals without separators", () => {
    expect(schemaPrice(189000)).toBe("1890");
    expect(schemaPrice(19050)).toBe("190.50");
  });
});

describe("normalizePlansResponse", () => {
  const body = {
    source: "stripe",
    currency: "thb",
    plans: [
      { tier: "lite", lookup_key: "noey_lite_monthly", interval: "month", unit_amount: 19000 },
      { tier: "starter", lookup_key: "noey_starter_monthly", interval: "month", unit_amount: 29000 },
      { tier: "pro", lookup_key: "noey_pro_monthly", interval: "month", unit_amount: 93000 },
      { tier: "studio", lookup_key: "noey_studio_monthly", interval: "month", unit_amount: 189000 },
    ],
  };

  it("maps the documented contract", () => {
    const table = normalizePlansResponse(body);
    expect(table?.source).toBe("stripe");
    expect(table?.prices.pro).toEqual({ amountSatang: 93000, lookupKey: "noey_pro_monthly" });
    expect(Object.keys(table?.prices ?? {})).toEqual(["lite", "starter", "pro", "studio"]);
  });

  it("treats anything but 'stripe' as the backend's mock source", () => {
    expect(normalizePlansResponse({ ...body, source: "mock" })?.source).toBe("mock");
  });

  it("drops unknown tiers, yearly prices and bad amounts instead of trusting them", () => {
    const table = normalizePlansResponse({
      source: "stripe",
      currency: "THB",
      plans: [
        { tier: "free", unit_amount: 0 },
        { tier: "enterprise", unit_amount: 999900 },
        { tier: "pro", interval: "year", unit_amount: 900000 },
        { tier: "lite", interval: "month", unit_amount: 190.5 },
        { tier: "starter", interval: "month", unit_amount: 29000 },
      ],
    });
    expect(Object.keys(table?.prices ?? {})).toEqual(["starter"]);
    expect(table?.prices.starter?.lookupKey).toBe("noey_starter_monthly");
  });

  it("rejects bodies that are not the contract", () => {
    expect(normalizePlansResponse(null)).toBeNull();
    expect(normalizePlansResponse({ currency: "usd", plans: [] })).toBeNull();
    expect(normalizePlansResponse({ currency: "thb", plans: [] })).toBeNull();
    expect(normalizePlansResponse({ detail: "Not Found" })).toBeNull();
  });
});

describe("fallback prices", () => {
  it("are the beta ladder while the beta runs", () => {
    const table = fallbackPriceTable(DURING_BETA);
    expect(table.source).toBe("fallback");
    for (const tier of PAID_TIERS) {
      expect(table.prices[tier]?.amountSatang).toBe(BETA_PRICES_THB[tier] * 100);
    }
    expect(displayPrice(table, "studio")).toBe("999");
    expect(displayPrice(table, "max")).toBe("3,499");
    expect(displayPrice(table, "free")).toBe("0");
  });

  it("revert to the full ladder the moment the beta ends, with no code change", () => {
    const table = fallbackPriceTable(AFTER_BETA);
    for (const tier of PAID_TIERS) {
      expect(table.prices[tier]?.amountSatang).toBe(FULL_PRICES_THB[tier] * 100);
    }
    expect(displayPrice(table, "studio")).toBe("1,990");
    expect(displayPrice(table, "max")).toBe("6,990");
  });

  it("finds the lowest paid price for 'from X baht' copy", () => {
    expect(lowestPaidPrice(fallbackPriceTable(DURING_BETA))?.amountSatang).toBe(9900);
    expect(lowestPaidPrice(fallbackPriceTable(AFTER_BETA))?.amountSatang).toBe(19900);
  });
});

describe("beta pricing", () => {
  it("is half the full price, rounded to a 9, on every paid plan", () => {
    for (const tier of PAID_TIERS) {
      const full = FULL_PRICES_THB[tier];
      const beta = BETA_PRICES_THB[tier];
      expect(beta % 10, `${tier} ends in 9`).toBe(9);
      expect(Math.abs(beta - full / 2), `${tier} is about half of ${full}`).toBeLessThanOrEqual(5);
    }
  });

  it("strikes the full price through beside the beta price", () => {
    const table = fallbackPriceTable(DURING_BETA);
    expect(strikePrice(table, "pro", DURING_BETA)).toBe("990");
    expect(strikePrice(table, "max", DURING_BETA)).toBe("6,990");
    // Nothing to strike on the free plan.
    expect(strikePrice(table, "free", DURING_BETA)).toBeNull();
  });

  it("strikes nothing once the beta is over — the site reverts by itself", () => {
    expect(strikePrice(fallbackPriceTable(AFTER_BETA), "pro", AFTER_BETA)).toBeNull();
    for (const tier of TIERS) {
      expect(strikePrice(fallbackPriceTable(AFTER_BETA), tier, AFTER_BETA)).toBeNull();
    }
  });

  it("claims a discount only when the backend is actually charging one", () => {
    expect(isBetaPriced(fallbackPriceTable(DURING_BETA), DURING_BETA)).toBe(true);
    expect(isBetaPriced(fallbackPriceTable(AFTER_BETA), AFTER_BETA)).toBe(false);
    // The catalog is the backend's: until it switches over, the date alone
    // must not put "ลด 50%" next to an undiscounted number.
    const notYet = normalizePlansResponse({
      source: "stripe",
      currency: "thb",
      plans: PAID_TIERS.map((tier) => ({ tier, interval: "month", unit_amount: FULL_PRICES_THB[tier] * 100 })),
    })!;
    expect(isBetaPriced(notYet, DURING_BETA)).toBe(false);
  });

  it("strikes nothing when the backend is already charging the full price", () => {
    const table = normalizePlansResponse({
      source: "stripe",
      currency: "thb",
      plans: [{ tier: "pro", interval: "month", unit_amount: FULL_PRICES_THB.pro * 100 }],
    });
    expect(table && strikePrice(table, "pro", DURING_BETA)).toBeNull();
  });

  it("never puts Starter's beta price next to Lite's full price in one grid", () => {
    // Both read "199"; they may not sit side by side. Lite lives in the second
    // row, so the main grid never shows the two together.
    expect(BETA_PRICES_THB.starter).toBe(FULL_PRICES_THB.lite);
    expect(MAIN_TIERS).not.toContain("lite");
    expect(EXTRA_TIERS).toContain("lite");
  });
});

describe("lookup keys", () => {
  it("round-trips tiers and keys", () => {
    const table = fallbackPriceTable();
    expect(lookupKeyFor(table, "pro")).toBe("noey_pro_monthly");
    expect(tierFromLookupKey(table, "noey_studio_monthly")).toBe("studio");
    expect(tierFromLookupKey(table, "something_else")).toBeNull();
    expect(tierFromLookupKey(table, null)).toBeNull();
  });

  it("shows a missing tier as unlisted rather than inventing a price", () => {
    const table = normalizePlansResponse({ source: "stripe", currency: "thb", plans: [{ tier: "pro", unit_amount: 93000 }] });
    expect(table && displayPrice(table, "lite")).toBeNull();
  });
});

describe("planDisplayName", () => {
  it("labels known tiers and survives legacy backend values", () => {
    expect(planDisplayName("free")).toBe("ฟรี");
    expect(planDisplayName("pro")).toBe("Pro");
    expect(planDisplayName("enterprise")).toBe("Enterprise");
    expect(planDisplayName(null)).toBe("ฟรี");
  });
});

describe("what a plan sells", () => {
  it("is an APPROXIMATE cut count per month, one map behind /pricing's counts", () => {
    // Owner, 2026-09-29: the cost of a cut is dominated by a fixed per-run
    // cost, not by the footage, so minutes were the wrong unit to sell.
    // Owner, 2026-10-01: HONEST counts — budget ÷ a 5-minute cut from the
    // fitted production model (185,070 Standard / 267,420 High), ROUNDED
    // DOWN. The backend's tests/test_plan_features.py pins the same numbers.
    expect(TIERS.map((tier) => APPROX_CUTS_PER_MONTH[tier])).toEqual([2, 4, 10, 30, 64, 140, 259]);
    expect(TIERS.map((tier) => APPROX_HIGH_CUTS_PER_MONTH[tier] ?? null)).toEqual([null, null, null, 20, 44, 97, 179]);
    expect(clipsHeadline("free")).toBe("ราว 2 คลิป");
    expect(clipsHeadline("pro")).toBe("ตัดได้ราว 30 คลิป/เดือน");
    const row = COMPARISON_ROWS.find((r) => r.label === "จำนวนคลิปต่อเดือน (โดยประมาณ)");
    expect(row?.values).toEqual(["ราว 2 คลิป ครั้งเดียว", ...TIERS.slice(1).map((tier) => clipsListItem(tier))]);
  });

  it("states no clip count in plan copy — /pricing's calculator is the only place counts appear", () => {
    // Owner, 2026-10-01: anywhere without the calculator a count is pinned to
    // a 5-minute ตัดฉากเด่น clip, which confused people.
    for (const tier of TIERS) {
      const text = JSON.stringify(PLAN_COPY[tier]);
      expect(text, `${tier} quotes a count`).not.toMatch(/คลิป\s*\/\s*เดือน|ราว \d+ คลิป/);
    }
  });

  it("quotes BOTH precisions exactly where the plan has the finer one", () => {
    for (const tier of TIERS) {
      const high = APPROX_HIGH_CUTS_PER_MONTH[tier];
      expect(Boolean(high), `${tier} high count vs precision`).toBe(hasHighPrecision(tier));
      if (high) expect(high, tier).toBeLessThan(APPROX_CUTS_PER_MONTH[tier]);
    }
    expect(clipsHighLine("pro")).toBe(`ระดับ${PRECISION_NAMES.high}ราว 20 คลิป`);
    expect(clipsHighLine("starter")).toBeNull();
    expect(clipsHeadlineFull("pro")).toBe("ตัดได้ราว 30 คลิป/เดือน · ระดับละเอียดราว 20 คลิป");
    expect(clipsHeadlineFull("lite")).toBe(clipsHeadline("lite"));
    const row = COMPARISON_ROWS.find((r) => r.label === `จำนวนคลิปต่อเดือน ระดับ${PRECISION_NAMES.high} (โดยประมาณ)`);
    expect(row?.values).toEqual(["—", "—", "—", "ราว 20 คลิป", "ราว 44 คลิป", "ราว 97 คลิป", "ราว 179 คลิป"]);
    expect(clipsHighListItem("lite")).toBeNull();
  });

  it("bigger plans buy each clip for less, at the full AND the beta ladder", () => {
    // The volume discount (owner, 2026-10-01) the "แพลนใหญ่ขึ้น" cue states.
    for (const ladder of [FULL_PRICES_THB, BETA_PRICES_THB]) {
      const perClip = PAID_TIERS.map((tier) => ladder[tier] / APPROX_CUTS_PER_MONTH[tier]);
      for (let i = 1; i < perClip.length; i++) expect(perClip[i]).toBeLessThan(perClip[i - 1]);
    }
  });

  it("never states a bare count — a long high-precision cut costs about four times an ordinary one", () => {
    // Without "ราว" the card promises a quota the product cannot hold for a
    // heavy user, and someone would eventually wire the number to a counter.
    for (const tier of TIERS) expect(clipsHeadline(tier), tier).toMatch(/ราว/);
    // The compact list form keeps the hedge too: an agent may quote one item.
    for (const tier of TIERS) expect(clipsListItem(tier), tier).toMatch(/^ราว \d+ คลิป$/);
    expect(clipsLadderSentence(["lite", "pro"])).toBe("Lite ราว 4 คลิป · Pro ราว 30 คลิป (ระดับละเอียดราว 20 คลิป)");
  });

  it("states what the count is estimated on, including that a run is priced before it starts", () => {
    expect(CLIPS_FOOTNOTE).toContain("คลิปดิบ 5 นาที");
    expect(CLIPS_FOOTNOTE).toContain("ระดับละเอียดใช้โควตามากกว่า");
    expect(CLIPS_FOOTNOTE).toContain("ระบบบอกก่อนเริ่มทุกครั้ง");
  });

  it("no longer sells a multiple of Lite — that ladder contradicts the clip counts", () => {
    for (const tier of TIERS) {
      const text = JSON.stringify(PLAN_COPY[tier]);
      expect(text, `${tier} still quotes a multiplier`).not.toMatch(/\dx/);
    }
  });

  it("show limits by their English names — one Monthly limit on every paid plan", () => {
    // Backend limits.py rule 1 (2026-09-30): no weekly or 5-hour sub-window.
    expect(PLAN_COPY.free.limits).toEqual(["Trial credit"]);
    for (const tier of PAID_TIERS) expect(PLAN_COPY[tier].limits, tier).toEqual(["Monthly limit"]);
    expect(TIERS.map((tier) => PLAN_COPY[tier].concurrentJobs)).toEqual([1, 1, 1, 2, 3, 4, 5]);
  });

  it("never state a token count in plan copy", () => {
    for (const tier of TIERS) {
      const text = JSON.stringify(PLAN_COPY[tier]);
      expect(text).not.toMatch(/token|โทเค็น/i);
    }
  });

  it("state ตัดฉากเด่น's footage cap per plan, the same one the cards and the table show", () => {
    // Owner, 2026-09-29; narrowed 2026-10-01: the per-plan ceiling is
    // ตัดฉากเด่น's alone, so every surface that states it names the mode, and
    // the two speech modes' two hours is said once, in its own row.
    expect(TIERS.map((tier) => FOOTAGE_PER_PROJECT[tier])).toEqual([
      "10 นาที",
      "10 นาที",
      "20 นาที",
      "30 นาที",
      "30 นาที",
      "30 นาที",
      "30 นาที",
    ]);
    for (const tier of TIERS) {
      const text = PLAN_COPY[tier].features.join("\n");
      expect(text, `${tier} names its footage cap`).toContain(`ฟุตเทจรวมโหมดตัดฉากเด่น ${FOOTAGE_PER_PROJECT[tier]}`);
      expect(text, `${tier} puts 2 hours on a card`).not.toContain("2 ชั่วโมง");
    }
    const row = COMPARISON_ROWS.find((r) => r.label === "ฟุตเทจรวมต่อโปรเจกต์ โหมดตัดฉากเด่น");
    expect(row?.values).toEqual(TIERS.map((tier) => FOOTAGE_PER_PROJECT[tier]));
    const speech = COMPARISON_ROWS.find((r) => r.label === "ฟุตเทจรวมต่อโปรเจกต์ โหมดตัดช่วงเงียบและตัดไฮไลต์จากคลิปยาว");
    expect(speech?.values).toEqual(TIERS.map(() => "2 ชั่วโมง"));
    expect(footageLadderSentence()).toContain("ฟรี 10 นาที");
    expect(footageLadderSentence()).toContain("Max 30 นาที");
  });

  it("never advertise the finer precision setting below Pro", () => {
    for (const tier of ["free", "lite", "starter"] as const) {
      expect(hasHighPrecision(tier), tier).toBe(false);
      const text = PLAN_COPY[tier].features.join("\n");
      expect(text, `${tier} must not offer the finer setting`).not.toContain(PRECISION_NAMES.high);
      expect(text, `${tier} says ${PRECISION_NAMES.standard}`).toContain(PRECISION_NAMES.standard);
    }
    for (const tier of ["pro", "studio", "agency", "max"] as const) {
      expect(hasHighPrecision(tier), tier).toBe(true);
    }
    const row = COMPARISON_ROWS.find((r) => r.label === "ความละเอียดการวิเคราะห์");
    expect(row?.values).toEqual(TIERS.map((tier) => precisionLabel(tier)));
  });

  it("names the two precision settings the way the editor's dial does", () => {
    // 2026-09-30 the editor renamed its dials; the site says ปกติ / ละเอียด
    // because that is the word the customer clicks. English "Standard"/"High"
    // named a control that no longer exists, so no surface may print it.
    expect(PRECISION_NAMES).toEqual({ standard: "ปกติ", high: "ละเอียด" });
    expect(precisionLabel("starter")).toBe("ปกติ");
    expect(precisionLabel("pro")).toBe("ปกติ และ ละเอียด");
    expect(precisionFeature("starter")).toBe("วิเคราะห์ระดับปกติ");
    expect(precisionFeature("pro")).toContain("วิเคราะห์ระดับละเอียด");
    const copy = [
      JSON.stringify(PLAN_COPY),
      JSON.stringify(COMPARISON_ROWS),
      TIERS.map((tier) => `${precisionLabel(tier)} ${precisionFeature(tier)}`).join("\n"),
    ].join("\n");
    for (const dead of ["Standard", "High"]) {
      expect(copy, `copy still prints "${dead}"`).not.toContain(dead);
    }
  });

  it("sells the free plan as a one-time credit, never as a recurring monthly plan", () => {
    const text = [
      PLAN_COPY.free.pricingBlurb,
      PLAN_COPY.free.homeBlurb,
      ...PLAN_COPY.free.features,
      // The billing card's caption for the free plan.
      FREE_CLIPS_CAPTION,
    ].join("\n");
    expect(text).toContain("ครั้งเดียว");
    expect(text).toContain("ไม่รีเซ็ต");
    expect(text).not.toContain("คลิป/เดือน");
    expect(text).not.toContain("ไม่หมดอายุ");
  });

  it("every comparison row has one value per plan, the clip count first", () => {
    for (const row of COMPARISON_ROWS) expect(row.values).toHaveLength(TIERS.length);
    expect(COMPARISON_ROWS[0].label).toContain("จำนวนคลิปต่อเดือน");
  });

  it("split into four main cards and three extra ones, covering every plan once", () => {
    expect([...MAIN_TIERS, ...EXTRA_TIERS].sort()).toEqual([...TIERS].sort());
  });
});
