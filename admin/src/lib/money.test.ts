import { describe, expect, it } from "vitest";
import {
  breakEvenByPlan,
  csvCell,
  forecast,
  forecastDefaults,
  jobCost,
  patchStepAt,
  planRow,
  priceAt,
  sttCost,
  summarize,
  tokenCost,
  userMoney,
  usersCsv,
  type Ctx,
} from "./money";
import type { CostConfig, UserFacts } from "./types";

const cfg: CostConfig = {
  fx_rate: 30,
  models: { m1: { input: 1, output: 10 } },
  // $120/h all-in (with keyterms) = ฿1/s at ฿30.
  stt: { s1: { usd_per_hour: 100, keyterms_usd_per_hour: 20 } },
  fixed: [{ id: "server", label: "server", value: 300 }],
  per_user: [
    { id: "sms", label: "SMS", value: 3, basis: "user" },
    { id: "mail", label: "mail", value: 1, basis: "clip" },
  ],
  vat_included: true,
  include_internal: true,
};

const ctx: Ctx = {
  cfg, modelDefaults: {}, sttDefaults: {}, prices: { free: 0, starter: 321, studio: 1000 }, days: 30,
  fxRate: 30, today: "2026-09-22", sellPer1M: 250,
};

function user(p: Partial<UserFacts>): UserFacts {
  return {
    id: 1, email: "a@x.th", display_name: null, plan: "free", internal: false, active: true, email_verified: true,
    created_at: "2026-08-01T00:00:00Z", subscription: { status: null, live: false, current_period_end: null },
    quota_limit_tokens: 0, usage_reset_at: null, tokens: [], stt: [], clips: 0, failed: 0, projects: 0,
    engine_pro_pct: null, precision_high_pct: null, last_active_at: null, last_active_days: 0,
    quota_used_tokens: 0, quota_used_pct: null, ...p,
  };
}

const A = user({
  id: 1, email: "a@x.th", plan: "starter", subscription: { status: "active", live: true, current_period_end: null },
  tokens: [{ model: "m1", feature: "video_cut", input: 1_000_000, output: 100_000, calls: 3 }],
  stt: [{ model: "s1", seconds: 100 }], clips: 10, failed: 1,
});
const B = user({ id: 2, email: "b@x.th", tokens: [{ model: "m1", feature: "video_effects", input: 500_000, output: 0, calls: 1 }], clips: 2, last_active_days: 20 });
const C = user({ id: 3, email: "owner@x.th", plan: "studio", internal: true, subscription: { status: "active", live: true, current_period_end: null } });

describe("per-user money", () => {
  it("prices legacy tokens and speech-to-text, extras and VAT-net revenue", () => {
    const a = userMoney(ctx, A);
    expect(a.token).toBeCloseTo(60); // ($1 in + $1 out) × 30
    expect(a.sttCost).toBeCloseTo(100); // 100 s × $120/h × 30
    expect(a.rateTokens).toBe(0); // legacy rows were never charged by the card
    expect(a.extra).toBeCloseTo(13); // 3 per user-month + 1 × 10 clips
    expect(a.cost).toBeCloseTo(173);
    expect(a.pays).toBeCloseTo(300); // 321 / 1.07
    expect(a.profit).toBeCloseTo(127);
    expect(a.tasks.cut).toBeCloseTo(60);
  });

  it("only a live, active, non-internal subscriber pays", () => {
    expect(userMoney(ctx, C).pays).toBe(0); // owner account
    expect(userMoney(ctx, { ...A, subscription: { status: "canceled", live: false, current_period_end: null } }).pays).toBe(0);
    expect(userMoney(ctx, { ...A, active: false }).pays).toBe(0);
  });

  it("prorates to the period and drops VAT when prices exclude it", () => {
    const week = userMoney({ ...ctx, days: 7 }, A);
    expect(week.pays).toBeCloseTo((300 * 7) / 30);
    const noVat = userMoney({ ...ctx, cfg: { ...cfg, vat_included: false } }, A);
    expect(noVat.pays).toBeCloseTo(321);
  });

  it("prices an unknown speech-to-text model dear, not cheap", () => {
    expect(sttCost(ctx, [{ model: "unknown", seconds: 3600 }])).toBeCloseTo((0.4 + 0.05) * 30);
  });
});

describe("ledger, break-even and plans", () => {
  const s = summarize(ctx, [A, B, C]);

  it("adds up the ledger the design shows", () => {
    expect(s.tPays).toBeCloseTo(300);
    expect(s.tToken).toBeCloseTo(75);
    expect(s.tStt).toBeCloseTo(100);
    expect(s.tExtra).toBeCloseTo(21);
    expect(s.otherFixed).toBeCloseTo(300);
    expect(s.costTotal).toBeCloseTo(496); // pay-as-you-go: no unused package any more
    expect(s.profit).toBeCloseTo(-196);
    const net = s.ledger.find((l) => l.bold)!;
    expect(net.label).toBe("ขาดทุนสุทธิ");
    expect(s.ledger.slice(0, -1).reduce((acc, l) => acc + l.value, 0)).toBeCloseTo(net.value);
    expect(s.freeCost).toBeCloseTo(20);
    expect(s.wasted).toBeCloseTo(17.3);
    expect(s.idle).toBe(1);
  });

  it("leaves internal accounts out when told to", () => {
    const without = summarize({ ...ctx, cfg: { ...cfg, include_internal: false } }, [A, B, C]);
    expect(without.counted.map((u) => u.id)).toEqual([1, 2]);
    expect(without.tExtra).toBeCloseTo(18);
  });

  it("computes the customers needed to break even", () => {
    expect(s.monthlyCost).toBeCloseTo(496);
    expect(s.deficit).toBeCloseTo(196);
    const starter = breakEvenByPlan(ctx, s).find((p) => p.key === "starter")!;
    expect(starter.margin).toBeCloseTo(127);
    expect(starter.need).toBe(2);
  });

  it("per-plan margin and the clip count that makes a plan lose money", () => {
    const row = planRow(ctx, s, "starter");
    expect(row.users).toBe(1);
    expect(row.avgCost).toBeCloseTo(173);
    expect(row.perUser).toBeCloseTo(127);
    expect(row.margin).toBeCloseTo(42.33, 1);
    expect(row.breakClips).toBe(17); // 300 / (173 / 10)
    const free = planRow(ctx, s, "free");
    expect(free.margin).toBeNull();
    expect(free.breakClips).toBeNull();
    expect(free.perUser).toBeCloseTo(-20);
  });

  it("falls back to the design's estimate for a plan nobody uses", () => {
    expect(s.planVarEstimated.pro).toBe(true);
    expect(s.planVar.pro).toBe(220);
  });

  it("forecasts from real defaults and honours a typed fixed cost", () => {
    const f = forecastDefaults(ctx, s);
    expect(f.counts.starter).toBe(1);
    expect(f.cost.starter).toBe(173);
    const out = forecast(ctx, s, { ...f, counts: { ...f.counts, starter: 10 }, fixed: 500 });
    expect(out.revenue).toBeCloseTo(3000);
    expect(out.variable).toBeCloseTo(1730 + 20);
    expect(out.profit).toBeCloseTo(3000 - 1750 - 500);
    // Auto fixed cost = the fixed items + what internal accounts cost (C: SMS ฿3).
    expect(forecast(ctx, s, f).fixedAuto).toBeCloseTo(303);
  });

  it("costs one project from its own rows", () => {
    const cost = jobCost(ctx, {
      uid: "u", name: null, mode: "dub_first", status: "done", engine: "pro", precision: "high", footage_sec: 60,
      created_at: null, tokens: A.tokens, stt: A.stt,
    });
    expect(cost).toBeCloseTo(160);
  });
});

describe("recorded cost (2026-09-22 onwards)", () => {
  const recordedRow = {
    model: "m1", feature: "video_cut", input: 1_000_000, output: 100_000, calls: 2,
    tokens: 1_552_500, cost_thb: 38.81, uncosted_input: 0, uncosted_output: 0, uncosted_cached: 0,
  };

  it("uses the cost the backend recorded, whatever the draft prices say", () => {
    expect(tokenCost(ctx, [recordedRow])).toBeCloseTo(38.81);
    const dearer = { ...ctx, cfg: { ...cfg, models: { m1: { input: 100, output: 100 } } } };
    expect(tokenCost(dearer, [recordedRow])).toBeCloseTo(38.81);
  });

  it("prices only the legacy part of a mixed group", () => {
    const mixed = { ...recordedRow, cost_thb: 10, uncosted_input: 1_000_000, uncosted_output: 0 };
    expect(tokenCost(ctx, [mixed])).toBeCloseTo(10 + 30);
    const cached = { ...mixed, uncosted_cached: 1_000_000 };
    expect(tokenCost(ctx, [cached])).toBeCloseTo(10 + 3); // cached at 10% of input
  });

  it("follows a dated price schedule for legacy rows", () => {
    const scheduled = { ...ctx, cfg: { ...cfg, models: { m1: { input: 1, output: 10, until: "2026-12-31", then: { input: 2, output: 20 } } } } };
    const legacy = [{ model: "m1", feature: "video_cut", input: 1_000_000, output: 0, calls: 1 }];
    expect(tokenCost(scheduled, legacy)).toBeCloseTo(30);
    expect(tokenCost({ ...scheduled, today: "2027-01-01" }, legacy)).toBeCloseTo(60);
    expect(priceAt(scheduled.cfg.models.m1, "2026-12-31").input).toBe(1);
  });

  it("edits the schedule step in force, not the expired one", () => {
    const p = { input: 1, output: 10, until: "2026-12-31", then: { input: 2, output: 20 } };
    expect(patchStepAt(p, "2026-09-22", { input: 1.5 })).toEqual({ ...p, input: 1.5 });
    expect(patchStepAt(p, "2027-02-01", { input: 2.5 })).toEqual({ ...p, then: { input: 2.5, output: 20 } });
  });

  it("speech-to-text: recorded cost plus legacy seconds", () => {
    expect(sttCost(ctx, [{ model: "s1", seconds: 200, tokens: 5175, cost_thb: 4.2, uncosted_seconds: 100 }])).toBeCloseTo(104.2);
  });

  it("cost and margin per 1M rate-card tokens come from charged rows only", () => {
    const D = user({ id: 4, tokens: [recordedRow], stt: [{ model: "s1", seconds: 60, tokens: 447_500, cost_thb: 21.19, uncosted_seconds: 0 }] });
    const s = summarize(ctx, [A, D]);
    expect(s.tRateTokens).toBe(2_000_000);
    expect(s.costPer1M).toBeCloseTo(30); // (38.81 + 21.19) / 2M × 1M
    expect(s.marginPer1M).toBeCloseTo(220);
    expect(summarize(ctx, [A]).costPer1M).toBeNull();
  });
});

describe("CSV", () => {
  it("neutralises formulas and quotes", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("@x")).toBe(`"'@x"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell('a,"b"')).toBe(`"a,""b"""`);
    expect(csvCell(-12.5)).toBe("-12.5"); // numbers stay numbers
  });

  it("exports every user with a BOM and a header", () => {
    const csv = usersCsv(summarize(ctx, [A, user({ id: 9, email: "=evil@x.th" })]));
    expect(csv.startsWith("﻿email,plan")).toBe(true);
    expect(csv.split("\n")[0]).toContain("ai_tokens");
    expect(csv).toContain(`"'=evil@x.th"`);
    expect(csv.trim().split("\n")).toHaveLength(3);
  });
});

describe("plan ladder coverage", () => {
  it("has a fallback cost figure for every plan key, including agency and max", async () => {
    const { PLAN_KEYS, PAID_KEYS } = await import("./plans");
    const { PLAN_VAR_FALLBACK } = await import("./money");
    for (const k of PLAN_KEYS) {
      expect(PLAN_VAR_FALLBACK[k]).toBeGreaterThan(0);
    }
    expect(PAID_KEYS).toEqual(["lite", "starter", "pro", "studio", "agency", "max"]);
  });
});

describe("top-ups and token pricing (billing phase)", () => {
  const T = user({
    id: 7, email: "t@x.th", plan: "lite", topup_satang: 50_000, topups: 2, wallet_spent_satang: 12_345,
    wallet_balance_satang: 37_655, quota_window: "weekly", quota_used_pct: 42.4,
  });
  const noVat: Ctx = { ...ctx, cfg: { ...cfg, vat_included: false } };

  it("counts a top-up as revenue in the period, gross, and in profit", () => {
    const t = userMoney(noVat, T);
    expect(t.topup).toBeCloseTo(500);
    expect(t.walletSpent).toBeCloseTo(123.45);
    expect(t.walletBalance).toBeCloseTo(376.55);
    expect(t.revenue).toBeCloseTo(500); // no live subscription
    expect(t.profit).toBeCloseTo(500 - t.cost);
  });

  it("an internal account's top-up is not revenue", () => {
    expect(userMoney(noVat, { ...T, internal: true }).topup).toBe(0);
  });

  it("summary totals, ledger line and the monthly projection include top-ups", () => {
    const s = summarize(noVat, [A, T]);
    expect(s.tTopup).toBeCloseTo(500);
    expect(s.tRevenue).toBeCloseTo(s.tPays + 500);
    expect(s.topupBuyers).toBe(1);
    expect(s.tWalletBalance).toBeCloseTo(376.55);
    expect(s.ledger.find((l) => l.label === "รายได้จากเติมเงิน")?.value).toBeCloseTo(500);
    expect(s.profit).toBeCloseTo(s.tRevenue - s.costTotal);
    expect(s.mRevenue).toBeCloseTo(s.mPays + s.mTopup);
  });

  it("exports the limit window and the balance, never a per-day quota", () => {
    const csv = usersCsv(summarize(noVat, [T]));
    const [head, row] = csv.replace("﻿", "").trim().split("\n");
    const cols = head.split(",");
    expect(cols).not.toContain("quota_today_pct");
    const cell = (k: string) => row.split(",")[cols.indexOf(k)];
    expect(cell("quota_window")).toBe("weekly");
    expect(cell("quota_pct")).toBe("42.4");
    expect(cell("topup_thb")).toBe("500");
    expect(cell("wallet_balance_thb")).toBe("376.55");
  });

  it("margin uses the admin's billing-config sell price over the rate card's", async () => {
    const { ctxFrom } = await import("./money");
    const base = {
      period: { from: "2026-09-01", to: "2026-09-30", days: 30 }, today: "2026-09-22", cost_config: cfg,
      model_defaults: {}, stt_defaults: {}, prices: { source: "mock", satang: {}, billing_enabled: false },
      rate_card: { sell_thb_per_1m: 250, reference_thb_per_1m: 50 },
    } as unknown as Parameters<typeof ctxFrom>[0];
    expect(ctxFrom(base).sellPer1M).toBe(250);
    const c = ctxFrom({ ...base, billing_config: { sell_thb_per_1m: 260, reference_thb_per_1m: 55 } } as typeof base);
    expect(c.sellPer1M).toBe(260);
    expect(c.referencePer1M).toBe(55);
  });

  it("run ratio is actual ÷ estimate, null without work", async () => {
    const { runRatio } = await import("./money");
    expect(runRatio({ estimate_tokens: 1000, actual_tokens: 1300 })).toBeCloseTo(1.3);
    expect(runRatio({ estimate_tokens: 1000, actual_tokens: 0 })).toBeNull();
    expect(runRatio({ estimate_tokens: 0, actual_tokens: 5 })).toBeNull();
  });
});
