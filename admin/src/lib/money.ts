/**
 * Every baht on the admin dashboard is computed here — and only here — from
 * the usage facts the backend returns and the owner's cost assumptions
 * (CostConfig). The formulas are the design's (Admin Dashboard.dc.html,
 * renderVals), driven by real usage rows instead of the prototype's seeded
 * estimates:
 *
 *  - tokens are priced per model from the logged input/output counts;
 *  - speech-to-text credits are ceil(seconds × credits/hour ÷ 3600) per model,
 *    priced at package price ÷ package credits;
 *  - per-user extras are per user-month (prorated) or per finished clip;
 *  - revenue counts only non-internal, active accounts with a LIVE
 *    subscription, net of 7% VAT when prices include it.
 *
 * Pure: no React, no fetch. money.test.ts pins the arithmetic.
 */

import { PAID_KEYS, PLAN_KEYS, PRICED_KEYS, taskForFeature } from "./plans";
import type { CostConfig, DashboardData, JobFacts, ModelPrice, SeriesBucket, SttRow, TokenRow, UserFacts } from "./types";

export const FALLBACK_MODEL_PRICE: ModelPrice = { input: 3, output: 15 };
export const FALLBACK_STT_RATE = 50_000;

/** The design's planVar fallback (THB/month) for a plan with no active users yet. */
export const PLAN_VAR_FALLBACK: Record<string, number> = {
  free: 30, lite: 55, starter: 90, pro: 220, studio: 480, agency: 900, max: 1540, enterprise: 480,
};
/** The design's monthly STT credits fallback per user for a plan with no data yet. */
export const PLAN_CREDITS_FALLBACK: Record<string, number> = {
  free: 2400, lite: 5200, starter: 8600, pro: 18600, studio: 34600, agency: 64000, max: 110000, enterprise: 34600,
};

export interface Ctx {
  cfg: CostConfig;
  modelDefaults: Record<string, ModelPrice>;
  sttRates: Record<string, number>;
  /** THB per month per plan; tiers without a sale price are 0. */
  prices: Record<string, number>;
  days: number;
}

export type TaskKey = "stt" | "cut" | "fx" | "style" | "extra" | "other";
export type TaskCosts = Record<TaskKey, number>;

export function pricesFromSatang(satang: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of PLAN_KEYS) out[k] = 0;
  for (const [k, v] of Object.entries(satang)) out[k] = Math.round(v) / 100;
  return out;
}

export function vatDivisor(cfg: CostConfig): number {
  return cfg.vat_included ? 1.07 : 1;
}

export function modelPrice(ctx: Pick<Ctx, "cfg" | "modelDefaults">, model: string): ModelPrice {
  return ctx.cfg.models[model] ?? ctx.modelDefaults[model] ?? FALLBACK_MODEL_PRICE;
}

export function tokenCostUsd(ctx: Pick<Ctx, "cfg" | "modelDefaults">, rows: Array<{ model: string; input: number; output: number }>): number {
  let usd = 0;
  for (const r of rows) {
    const p = modelPrice(ctx, r.model);
    usd += (r.input * p.input + r.output * p.output) / 1e6;
  }
  return usd;
}

export function tokenCost(ctx: Pick<Ctx, "cfg" | "modelDefaults">, rows: Array<{ model: string; input: number; output: number }>): number {
  return tokenCostUsd(ctx, rows) * ctx.cfg.fx_rate;
}

export function sttRate(ctx: Pick<Ctx, "cfg" | "sttRates">, model: string): number {
  if (model === ctx.cfg.stt.model) return ctx.cfg.stt.credits_per_hour;
  return ctx.sttRates[model] ?? FALLBACK_STT_RATE;
}

export function sttCredits(ctx: Pick<Ctx, "cfg" | "sttRates">, rows: SttRow[]): number {
  let credits = 0;
  for (const r of rows) if (r.seconds > 0) credits += Math.ceil((r.seconds * sttRate(ctx, r.model)) / 3600);
  return credits;
}

export function perCredit(cfg: CostConfig): number {
  return Number(cfg.stt.monthly_price || 0) / (Number(cfg.stt.credits) || 1);
}

export function sttMinutes(rows: SttRow[]): number {
  return rows.reduce((s, r) => s + r.seconds, 0) / 60;
}

/** Token cost split into the design's task buckets. */
export function taskTokenCosts(ctx: Pick<Ctx, "cfg" | "modelDefaults">, rows: TokenRow[]): Record<"cut" | "fx" | "style" | "other", number> {
  const out = { cut: 0, fx: 0, style: 0, other: 0 };
  for (const r of rows) out[taskForFeature(r.feature)] += tokenCost(ctx, [r]);
  return out;
}

export function extraCost(cfg: CostConfig, clips: number, active: boolean, days: number): number {
  return cfg.per_user.reduce((s, x) => {
    const v = Number(x.value || 0);
    return s + (x.basis === "clip" ? v * clips : active ? (v * days) / 30 : 0);
  }, 0);
}

export interface UserMoney extends UserFacts {
  token: number;
  tasks: TaskCosts;
  credits: number;
  sttCost: number;
  sttMin: number;
  extra: number;
  cost: number;
  planPrice: number;
  pays: number;
  profit: number;
}

export function userMoney(ctx: Ctx, u: UserFacts): UserMoney {
  const byTask = taskTokenCosts(ctx, u.tokens);
  const token = byTask.cut + byTask.fx + byTask.style + byTask.other;
  const credits = sttCredits(ctx, u.stt);
  const sttCost = credits * perCredit(ctx.cfg);
  const extra = extraCost(ctx.cfg, u.clips, u.active, ctx.days);
  const cost = token + sttCost + extra;
  const planPrice = Number(ctx.prices[u.plan] || 0);
  const paying = !u.internal && u.active && u.subscription.live && planPrice > 0;
  const pays = paying ? (planPrice / vatDivisor(ctx.cfg)) * (ctx.days / 30) : 0;
  return {
    ...u,
    token,
    tasks: { stt: sttCost, extra, ...byTask },
    credits,
    sttCost,
    sttMin: sttMinutes(u.stt),
    extra,
    cost,
    planPrice,
    pays,
    profit: pays - cost,
  };
}

export interface LedgerLine {
  sign: string;
  label: string;
  value: number;
  first?: boolean;
  bold?: boolean;
}

export interface Summary {
  all: UserMoney[];
  counted: UserMoney[];
  tPays: number;
  tToken: number;
  tStt: number;
  tExtra: number;
  tCredits: number;
  tClips: number;
  tMin: number;
  tFailed: number;
  fixedMonth: number;
  sttMonth: number;
  otherFixed: number;
  sttUnused: number;
  costTotal: number;
  profit: number;
  payers: number;
  freeCost: number;
  monthFactor: number;
  mPays: number;
  mToken: number;
  mStt: number;
  mCredits: number;
  mExtra: number;
  monthlyCost: number;
  monthlyProfit: number;
  ledger: LedgerLine[];
  planVar: Record<string, number>;
  planVarEstimated: Record<string, boolean>;
  deficit: number;
  taskTotals: TaskCosts;
  wasted: number;
  idle: number;
}

export function summarize(ctx: Ctx, users: UserFacts[]): Summary {
  const all = users.map((u) => userMoney(ctx, u));
  const counted = all.filter((u) => ctx.cfg.include_internal || !u.internal);
  const sum = (f: (u: UserMoney) => number) => counted.reduce((s, u) => s + f(u), 0);

  const tPays = sum((u) => u.pays);
  const tToken = sum((u) => u.token);
  const tStt = sum((u) => u.sttCost);
  const tExtra = sum((u) => u.extra);
  const tCredits = sum((u) => u.credits);
  const tClips = sum((u) => u.clips);
  const tMin = sum((u) => u.sttMin);
  const tFailed = sum((u) => u.failed);

  const days = ctx.days;
  const fixedMonth = ctx.cfg.fixed.reduce((s, f) => s + Number(f.value || 0), 0);
  const sttMonth = Number(ctx.cfg.stt.monthly_price || 0);
  const otherFixed = (fixedMonth * days) / 30;
  const sttUnused = Math.max(0, (sttMonth * days) / 30 - tStt);
  const costTotal = tToken + tStt + tExtra + sttUnused + otherFixed;
  const profit = tPays - costTotal;
  const payers = counted.filter((u) => u.pays > 0).length;
  const freeCost = counted.filter((u) => !u.internal && u.planPrice === 0).reduce((s, u) => s + u.cost, 0);

  const monthFactor = 30 / days;
  const mPays = tPays * monthFactor;
  const mToken = tToken * monthFactor;
  const mStt = tStt * monthFactor;
  const mCredits = tCredits * monthFactor;
  const mExtra = tExtra * monthFactor;
  const monthlyCost = mToken + mExtra + fixedMonth + sttMonth;
  const monthlyProfit = mPays - monthlyCost;

  const ledger: LedgerLine[] = [
    { sign: "", label: "รายได้จากค่าสมาชิก", value: tPays, first: true },
    { sign: "−", label: "โทเค็น AI", value: -tToken },
    { sign: "−", label: "ค่าถอดเสียงส่วนที่ใช้จริง", value: -tStt },
    { sign: "−", label: "SMS และอีเมลต่อผู้ใช้", value: -tExtra },
    { sign: "−", label: "เครดิตถอดเสียงที่ไม่ได้ใช้", value: -sttUnused },
    { sign: "−", label: "เซิร์ฟเวอร์และอื่นๆ", value: -otherFixed },
    { sign: "=", label: profit >= 0 ? "กำไรสุทธิ" : "ขาดทุนสุทธิ", value: profit, bold: true },
  ];

  const planVar: Record<string, number> = {};
  const planVarEstimated: Record<string, boolean> = {};
  for (const k of PLAN_KEYS) {
    const g = counted.filter((u) => u.plan === k && !u.internal && u.clips > 0);
    planVarEstimated[k] = g.length === 0;
    planVar[k] = g.length ? (g.reduce((s, u) => s + u.cost, 0) / g.length) * monthFactor : PLAN_VAR_FALLBACK[k];
  }
  const deficit = Math.max(0, monthlyCost - mPays);

  const taskTotals: TaskCosts = { stt: 0, cut: 0, fx: 0, style: 0, extra: 0, other: 0 };
  for (const u of counted) for (const k of Object.keys(taskTotals) as TaskKey[]) taskTotals[k] += u.tasks[k];

  const wasted = counted.reduce((s, u) => s + (u.clips ? (u.cost / u.clips) * u.failed : 0), 0);
  const idle = counted.filter((u) => u.last_active_days === null || u.last_active_days >= 14).length;

  return {
    all, counted, tPays, tToken, tStt, tExtra, tCredits, tClips, tMin, tFailed, fixedMonth, sttMonth,
    otherFixed, sttUnused, costTotal, profit, payers, freeCost, monthFactor, mPays, mToken, mStt, mCredits,
    mExtra, monthlyCost, monthlyProfit, ledger, planVar, planVarEstimated, deficit, taskTotals, wasted, idle,
  };
}

/** Break-even: customers per paid plan to cover the monthly deficit. */
export function breakEvenByPlan(ctx: Ctx, s: Summary): Array<{ key: string; margin: number; need: number | null }> {
  return PAID_KEYS.map((k) => {
    const margin = Number(ctx.prices[k] || 0) / vatDivisor(ctx.cfg) - s.planVar[k];
    return { key: k, margin, need: s.deficit <= 0 || margin <= 0 ? null : Math.ceil(s.deficit / margin) };
  });
}

export interface PlanRow {
  key: string;
  price: number;
  users: number;
  revenue: number;
  avgCost: number;
  perUser: number;
  /** null for a plan without a price. */
  margin: number | null;
  /** Clips per month past which the plan loses money; null when it loses from the first clip. */
  breakClips: number | null;
}

export function planRow(ctx: Ctx, s: Summary, k: string, price = Number(ctx.prices[k] || 0)): PlanRow {
  const g = s.counted.filter((u) => u.plan === k && !u.internal);
  const vat = vatDivisor(ctx.cfg);
  const revenue = g.reduce((acc, u) => acc + u.pays, 0) * s.monthFactor;
  const avg = s.planVar[k];
  const net = price / vat;
  const per = net - avg;
  const clipsAvg = g.length ? (g.reduce((acc, u) => acc + u.clips, 0) / g.length) * s.monthFactor : 8;
  const perClipCost = clipsAvg > 0 ? avg / clipsAvg : 6;
  return {
    key: k,
    price,
    users: g.length,
    revenue,
    avgCost: avg,
    perUser: price === 0 ? -avg : per,
    margin: price === 0 ? null : (per / net) * 100,
    breakClips: price === 0 ? null : Math.floor(net / Math.max(0.01, perClipCost)),
  };
}

export interface ForecastIn {
  counts: Record<string, number>;
  price: Record<string, number>;
  cost: Record<string, number>;
  fixed: number | null;
}

export interface ForecastOut {
  users: number;
  payingUsers: number;
  revenue: number;
  variable: number;
  fixed: number;
  fixedAuto: number;
  unused: number;
  profit: number;
  credits: number;
  needStarter: number;
  needPro: number;
}

export function forecastDefaults(ctx: Ctx, s: Summary): ForecastIn {
  const counts: Record<string, number> = {};
  const price: Record<string, number> = {};
  const cost: Record<string, number> = {};
  for (const k of PRICED_KEYS) {
    counts[k] = s.counted.filter((u) => u.plan === k && !u.internal).length;
    price[k] = Number(ctx.prices[k] || 0);
    cost[k] = Math.round(s.planVar[k]);
  }
  return { counts, price, cost, fixed: null };
}

export function forecast(ctx: Ctx, s: Summary, f: ForecastIn): ForecastOut {
  const vat = vatDivisor(ctx.cfg);
  const revenue = PRICED_KEYS.reduce((acc, k) => acc + (f.counts[k] || 0) * (f.price[k] / vat), 0);
  const variable = PRICED_KEYS.reduce((acc, k) => acc + (f.counts[k] || 0) * f.cost[k], 0);
  const internal = s.counted.filter((u) => u.internal);
  const internalCost = internal.reduce((acc, u) => acc + u.cost, 0) * s.monthFactor;
  const internalCredits = internal.reduce((acc, u) => acc + u.credits, 0) * s.monthFactor;
  const credits = PRICED_KEYS.reduce((acc, k) => {
    const g = s.counted.filter((u) => u.plan === k && !u.internal && u.clips > 0);
    const avg = g.length ? (g.reduce((x, u) => x + u.credits, 0) / g.length) * s.monthFactor : PLAN_CREDITS_FALLBACK[k];
    return acc + (f.counts[k] || 0) * avg;
  }, 0);
  const unused = Math.max(0, s.sttMonth - (credits + internalCredits) * perCredit(ctx.cfg));
  const fixedAuto = s.fixedMonth + unused + internalCost;
  const fixed = f.fixed === null ? fixedAuto : f.fixed;
  const profit = revenue - variable - fixed;
  const need = (k: string) => Math.ceil(Math.abs(profit) / Math.max(1, f.price[k] / vat - f.cost[k]));
  return {
    users: PRICED_KEYS.reduce((acc, k) => acc + (f.counts[k] || 0), 0),
    payingUsers: PRICED_KEYS.filter((k) => f.price[k] > 0).reduce((acc, k) => acc + (f.counts[k] || 0), 0),
    revenue,
    variable,
    fixed,
    fixedAuto,
    unused,
    profit,
    credits,
    needStarter: need("starter"),
    needPro: need("pro"),
  };
}

/** Variable cost of one bucket of the product-wide series. */
export function bucketVariableCost(ctx: Ctx, buckets: SeriesBucket[], activeUsers: number, daysInBucket: number): number {
  let cost = 0;
  let clips = 0;
  for (const b of buckets) {
    cost += tokenCost(ctx, b.tokens) + sttCredits(ctx, b.stt) * perCredit(ctx.cfg);
    clips += b.clips;
  }
  for (const x of ctx.cfg.per_user) {
    cost += x.basis === "clip" ? x.value * clips : (x.value * activeUsers * daysInBucket) / 30;
  }
  return cost;
}

export interface ChartDay {
  date: string;
  variable: number;
  fixed: number;
  inPeriod: boolean;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dailyChart(ctx: Ctx, data: DashboardData, s: Summary): { days: ChartDay[]; revenuePerDay: number; fixedPerDay: number } {
  const buckets = data.daily.filter((b) => ctx.cfg.include_internal || !b.internal);
  const active = s.counted.filter((u) => u.active).length;
  const fixedPerDay = (s.fixedMonth + Math.max(0, s.sttMonth - s.mStt)) / 30;
  const days: ChartDay[] = [];
  for (let i = 0; i < data.chart.days; i++) {
    const date = addDays(data.chart.from, i);
    days.push({
      date,
      variable: bucketVariableCost(ctx, buckets.filter((b) => b.key === date), active, 1),
      fixed: fixedPerDay,
      inPeriod: date >= data.period.from && date <= data.period.to,
    });
  }
  return { days, revenuePerDay: s.mPays / 30, fixedPerDay };
}

export interface MonthBar {
  key: string;
  revenue: number;
  cost: number;
}

function daysInMonth(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Month against month. Cost is real usage + the fixed costs of the month
 * (prorated for the current one). Revenue for past months is an ESTIMATE:
 * today's live subscribers who had already signed up by then — there is no
 * invoice history here.
 */
export function monthBars(ctx: Ctx, data: DashboardData, s: Summary): MonthBar[] {
  const buckets = data.monthly.filter((b) => ctx.cfg.include_internal || !b.internal);
  const current = data.months[data.months.length - 1];
  const vat = vatDivisor(ctx.cfg);
  return data.months.map((key) => {
    const len = daysInMonth(key);
    const span = key === current ? data.month_to_date_days : len;
    const share = span / len;
    const monthEnd = `${key}-${String(len).padStart(2, "0")}`;
    const members = s.counted.filter((u) => !u.internal && (u.created_at ?? "").slice(0, 10) <= monthEnd);
    const active = members.filter((u) => u.active).length;
    const variable = bucketVariableCost(ctx, buckets.filter((b) => b.key === key), active, span);
    const revenue = members
      .filter((u) => u.active && u.subscription.live && u.planPrice > 0)
      .reduce((acc, u) => acc + (u.planPrice / vat) * share, 0);
    return { key, revenue, cost: variable + (s.fixedMonth + s.sttMonth) * share };
  });
}

/** Cost of one project from its own usage rows (tokens + speech-to-text). */
export function jobCost(ctx: Ctx, job: JobFacts): number {
  return tokenCost(ctx, job.tokens) + sttCredits(ctx, job.stt) * perCredit(ctx.cfg);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Neutralise spreadsheet formulas (=, +, -, @, tab, CR) and quote. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEAD = [
  "email", "plan", "active", "pays_thb", "cost_thb", "profit_thb", "clips", "failed",
  "stt_minutes", "stt_credits", "token_cost_thb", "last_active_days", "quota_today_pct",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function usersCsv(s: Summary): string {
  const lines = [CSV_HEAD.join(",")];
  for (const u of s.all) {
    lines.push(
      [
        csvCell(u.email), csvCell(u.plan), csvCell(u.active ? "yes" : "no"), csvCell(round2(u.pays)),
        csvCell(round2(u.cost)), csvCell(round2(u.profit)), csvCell(u.clips), csvCell(u.failed),
        csvCell(Math.round(u.sttMin)), csvCell(u.credits), csvCell(round2(u.token)),
        csvCell(u.last_active_days), csvCell(u.quota_used_pct),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\n") + "\n";
}

export function ctxFrom(data: DashboardData, cfg: CostConfig = data.cost_config, prices?: Record<string, number>): Ctx {
  return {
    cfg,
    modelDefaults: data.model_defaults,
    sttRates: data.stt_rates,
    prices: prices ?? pricesFromSatang(data.prices.satang),
    days: data.period.days,
  };
}
