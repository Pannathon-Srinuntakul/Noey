import { describe, expect, it } from "vitest";
import { FX_BAND, fxSourceLabel, monthOf, previousMonth, validFxOverride, validInvoice, validMonth, VENDOR_LABELS } from "./billing";

describe("FX + reconciliation argument checks", () => {
  it("accepts only YYYY-MM months", () => {
    expect(validMonth("2026-09")).toBe(true);
    expect(validMonth("2026-13")).toBe(false);
    expect(validMonth("2026-9")).toBe(false);
    expect(validMonth("2026-09; drop")).toBe(false);
    expect(validMonth(202609)).toBe(false);
  });

  it("keeps an override inside the sane band, or clears it", () => {
    expect(validFxOverride(null)).toBe(true);
    expect(validFxOverride(34.5)).toBe(true);
    expect(validFxOverride(FX_BAND[0] - 0.01)).toBe(false);
    expect(validFxOverride(FX_BAND[1] + 0.01)).toBe(false);
    expect(validFxOverride(Number.NaN)).toBe(false);
  });

  it("invoices: known vendors, finite non-negative baht", () => {
    expect(validInvoice("gemini", 1234.5)).toBe(true);
    expect(validInvoice("elevenlabs", 0)).toBe(true);
    expect(validInvoice("aws", 1)).toBe(false);
    expect(validInvoice("gemini", -1)).toBe(false);
    expect(validInvoice("gemini", Infinity)).toBe(false);
  });

  it("month helpers", () => {
    expect(monthOf("2026-09-22")).toBe("2026-09");
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
  });

  it("labels name the work, never the vendor", () => {
    for (const label of Object.values(VENDOR_LABELS)) expect(label).not.toMatch(/gemini|google|eleven/i);
    expect(fxSourceLabel("override")).toBe("กำหนดเอง");
    expect(fxSourceLabel("open.er-api.com")).not.toContain("er-api");
  });
});

describe("limits, wallet, breaker, accuracy helpers", async () => {
  const b = await import("./billing");
  const plans = await import("./plans");

  it("limit labels are the owner's English names", () => {
    expect(b.WINDOW_LABELS).toEqual({ five_hour: "5-hour limit", weekly: "Weekly limit", monthly: "Monthly limit" });
    expect(b.validWindow("weekly")).toBe(true);
    expect(b.validWindow("daily")).toBe(false);
  });

  it("wallet adjustments: signed whole satang, non-zero, bounded, with a reason", () => {
    expect(b.validWalletAdjust(10_000, "goodwill")).toBe(true);
    expect(b.validWalletAdjust(-500, "fix")).toBe(true);
    expect(b.validWalletAdjust(0, "x")).toBe(false);
    expect(b.validWalletAdjust(1.5, "x")).toBe(false);
    expect(b.validWalletAdjust(b.WALLET_ADJUST_MAX_SATANG + 1, "x")).toBe(false);
    expect(b.validWalletAdjust(100, "   ")).toBe(false);
    expect(b.validWalletAdjust(100, "x".repeat(201))).toBe(false);
    expect(b.bahtToSatang(12.345)).toBe(1235);
    expect(b.bahtToSatang(-3)).toBe(-300);
  });

  it("breaker settings mirror the backend bounds", () => {
    const ok = { enabled: true, daily_cap_thb: 3000, hard_stop_ratio: 1.25, alert_email: null };
    expect(b.validBreaker(ok)).toBe(true);
    expect(b.validBreaker({ ...ok, alert_email: "ops@x.th" })).toBe(true);
    expect(b.validBreaker({ ...ok, hard_stop_ratio: 0.9 })).toBe(false);
    expect(b.validBreaker({ ...ok, daily_cap_thb: -1 })).toBe(false);
    expect(b.validBreaker({ ...ok, alert_email: "nope" })).toBe(false);
    expect(b.validBreaker({ ...ok, enabled: "yes" })).toBe(false);
    expect(b.validPer1M(250)).toBe(true);
    expect(b.validPer1M(0)).toBe(false);
    expect(b.validPer1M(10_001)).toBe(false);
  });

  it("reset times render in the viewer's timezone", () => {
    const iso = "2026-09-22T14:30:00Z";
    expect(b.formatResetAt(iso, "Asia/Bangkok")).toContain("21:30");
    expect(b.formatResetAt(iso, "UTC")).toContain("14:30");
    expect(b.formatResetAt(null)).toBe("เริ่มนับเมื่อใช้ครั้งถัดไป");
  });

  it("accuracy verdict flags under- and over-estimates", () => {
    const base = { runs: 20, p90_ratio: 1.2, over_ceiling: 0, limit_stops: 0, estimate_tokens: 1, actual_tokens: 1 };
    expect(b.accuracyVerdict(undefined)).toBe("none");
    expect(b.accuracyVerdict({ ...base, median_ratio: 0.9 })).toBe("good");
    expect(b.accuracyVerdict({ ...base, median_ratio: 1.2 })).toBe("under");
    expect(b.accuracyVerdict({ ...base, median_ratio: 0.9, over_ceiling: 2 })).toBe("under");
    expect(b.accuracyVerdict({ ...base, median_ratio: 0.5 })).toBe("over");
    expect(b.ratioLabel(1.234)).toBe("×1.23");
  });

  it("plan limits match the backend table (weekly = monthly ÷ 4.33, 5-hour = 40%)", () => {
    expect(plans.weeklyLimit(plans.PLAN_LIMITS.pro.monthly)).toBe(923_787);
    expect(plans.fiveHourLimit(plans.PLAN_LIMITS.pro.monthly)).toBe(369_514);
    expect(plans.PLAN_LIMITS.free.windows).toEqual(["monthly"]);
    expect(plans.PLAN_LIMITS.starter.windows).toEqual(["weekly"]);
    expect(plans.PLAN_LIMITS.max).toMatchObject({ monthly: 28_000_000, concurrency: 5, storageGb: 100 });
  });

  it("run labels never name a vendor", () => {
    for (const l of [...Object.values(b.RUN_KIND_LABEL), ...Object.values(b.OUTCOME_LABEL)]) {
      expect(l).not.toMatch(/gemini|google|eleven|claude|scribe/i);
    }
  });

  it("flags a user whose failed runs look like abuse", () => {
    const base = { since: "2026-08-23T00:00:00Z", runs: 0, refunded_runs: 0, charged_after_cap_runs: 0, refunded_tokens: 0, cost_thb: 0 };
    expect(b.failedRunsVerdict(null)).toBe("none");
    expect(b.failedRunsVerdict(base)).toBe("none");
    expect(b.failedRunsVerdict({ ...base, runs: 2, refunded_runs: 2 })).toBe("normal");
    expect(b.failedRunsVerdict({ ...base, runs: b.FAILED_RUNS_WATCH, refunded_runs: b.FAILED_RUNS_WATCH })).toBe("watch");
    expect(b.failedRunsVerdict({ ...base, runs: 1, charged_after_cap_runs: 1 })).toBe("watch");
  });

  it("names a failed run charged past the refund allowance apart from a refunded one", () => {
    expect(b.outcomeLabel("our_failure", "refunded")).toBe(b.OUTCOME_LABEL.our_failure);
    expect(b.outcomeLabel("our_failure", "settled")).not.toBe(b.OUTCOME_LABEL.our_failure);
    expect(b.outcomeLabel(null, "queued")).toBe("รอคิว");
    expect(b.outcomeLabel("ok", "settled")).toBe("สำเร็จ");
  });
});
