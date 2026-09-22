import { describe, expect, it } from "vitest";
import {
  breakEvenByPlan,
  csvCell,
  forecast,
  forecastDefaults,
  jobCost,
  planRow,
  sttCredits,
  summarize,
  userMoney,
  usersCsv,
  type Ctx,
} from "./money";
import type { CostConfig, UserFacts } from "./types";

const cfg: CostConfig = {
  fx_rate: 30,
  models: { m1: { input: 1, output: 10 } },
  stt: { model: "s1", credits_per_hour: 3600, monthly_price: 1000, credits: 1000 },
  fixed: [{ id: "server", label: "server", value: 300 }],
  per_user: [
    { id: "sms", label: "SMS", value: 3, basis: "user" },
    { id: "mail", label: "mail", value: 1, basis: "clip" },
  ],
  vat_included: true,
  include_internal: true,
};

const ctx: Ctx = { cfg, modelDefaults: {}, sttRates: { s1: 3600 }, prices: { free: 0, starter: 321, studio: 1000 }, days: 30 };

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
  it("prices tokens, credits, extras and VAT-net revenue", () => {
    const a = userMoney(ctx, A);
    expect(a.token).toBeCloseTo(60); // ($1 in + $1 out) × 30
    expect(a.credits).toBe(100);
    expect(a.sttCost).toBeCloseTo(100);
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

  it("rounds speech-to-text credits up per model row", () => {
    expect(sttCredits(ctx, [{ model: "s1", seconds: 0.2 }])).toBe(1);
    expect(sttCredits(ctx, [{ model: "unknown", seconds: 3600 }])).toBe(50_000);
  });
});

describe("ledger, break-even and plans", () => {
  const s = summarize(ctx, [A, B, C]);

  it("adds up the ledger the design shows", () => {
    expect(s.tPays).toBeCloseTo(300);
    expect(s.tToken).toBeCloseTo(75);
    expect(s.tStt).toBeCloseTo(100);
    expect(s.tExtra).toBeCloseTo(21);
    expect(s.sttUnused).toBeCloseTo(900);
    expect(s.otherFixed).toBeCloseTo(300);
    expect(s.costTotal).toBeCloseTo(1396);
    expect(s.profit).toBeCloseTo(-1096);
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
    expect(s.monthlyCost).toBeCloseTo(1396);
    expect(s.deficit).toBeCloseTo(1096);
    const starter = breakEvenByPlan(ctx, s).find((p) => p.key === "starter")!;
    expect(starter.margin).toBeCloseTo(127);
    expect(starter.need).toBe(9);
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
  });

  it("costs one project from its own rows", () => {
    const cost = jobCost(ctx, {
      uid: "u", name: null, mode: "dub_first", status: "done", engine: "pro", precision: "high", footage_sec: 60,
      created_at: null, tokens: A.tokens, stt: A.stt,
    });
    expect(cost).toBeCloseTo(160);
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
    expect(csv).toContain(`"'=evil@x.th"`);
    expect(csv.trim().split("\n")).toHaveLength(3);
  });
});

describe("plan ladder coverage", () => {
  it("has a fallback cost and credit figure for every plan key, including agency and max", async () => {
    const { PLAN_KEYS, PAID_KEYS } = await import("./plans");
    const { PLAN_VAR_FALLBACK, PLAN_CREDITS_FALLBACK } = await import("./money");
    for (const k of PLAN_KEYS) {
      expect(PLAN_VAR_FALLBACK[k]).toBeGreaterThan(0);
      expect(PLAN_CREDITS_FALLBACK[k]).toBeGreaterThan(0);
    }
    expect(PAID_KEYS).toEqual(["lite", "starter", "pro", "studio", "agency", "max"]);
  });
});
