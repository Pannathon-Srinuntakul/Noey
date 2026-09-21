import { describe, expect, it } from "vitest";
import {
  FALLBACK_PRICES_THB,
  PAID_TIERS,
  displayPrice,
  fallbackPriceTable,
  formatBaht,
  lookupKeyFor,
  lowestPaidPrice,
  normalizePlansResponse,
  planDisplayName,
  schemaPrice,
  tierFromLookupKey,
} from "./plans";

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
  it("are the design's mock prices, in satang, for every paid tier", () => {
    const table = fallbackPriceTable();
    expect(table.source).toBe("fallback");
    for (const tier of PAID_TIERS) {
      expect(table.prices[tier]?.amountSatang).toBe(FALLBACK_PRICES_THB[tier] * 100);
    }
    expect(displayPrice(table, "studio")).toBe("1,890");
    expect(displayPrice(table, "free")).toBe("0");
  });

  it("finds the lowest paid price for 'from X baht' copy", () => {
    expect(lowestPaidPrice(fallbackPriceTable())?.amountSatang).toBe(19000);
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
