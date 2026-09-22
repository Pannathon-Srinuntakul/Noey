/**
 * Every baht on the admin dashboard is computed here — and only here — from
 * the usage facts the backend returns and the owner's cost assumptions
 * (CostConfig). The formulas are the design's (Admin Dashboard.dc.html,
 * renderVals), driven by real usage rows instead of the prototype's seeded
 * estimates:
 *
 *  - AI and speech-to-text cost is what each usage row RECORDED (`cost_thb`,
 *    priced by the backend when the request happened). Only legacy rows from
 *    before 2026-09-22 carry no cost; their vendor units (`uncosted_*`) are
 *    priced here from the owner's (draft) price table at today's schedule and
 *    the live FX rate — speech-to-text as pay-as-you-go per hour, assuming
 *    keyterms were sent (the worker always sends the project's);
 *  - rate-card tokens (`tokens`) give cost per 1M and margin per 1M against
 *    the ฿250 sell price — users are charged by the card, never by cost;
 *  - per-user extras are per user-month (prorated) or per finished clip;
 *  - revenue counts only non-internal, active accounts with a LIVE
 *    subscription, plus top-ups (extra usage) bought in the period — gross,
 *    before the payment fee — all net of 7% VAT only when prices include it
 *    (off by default: the owner is not VAT-registered).
 *
 * Pure: no React, no fetch. money.test.ts pins the arithmetic.
 */

import { PAID_KEYS, PLAN_KEYS, PRICED_KEYS, taskForFeature } from "./plans";
import type {
  CostConfig, CostFacts, DashboardData, JobFacts, ModelPrice, RunFacts, SeriesBucket, SttModelPrice, SttRow, TokenRow,
  UserFacts,
} from "./types";

/** The dearest list price we know (3.1 Pro): an unpriced model must not read as free. */
export const FALLBACK_MODEL_PRICE: ModelPrice = { input: 2, output: 12 };
export const FALLBACK_STT_PRICE: SttModelPrice = { usd_per_hour: 0.4, keyterms_usd_per_hour: 0.05 };
export const DEFAULT_SELL_PER_1M = 250;
export const DEFAULT_REFERENCE_PER_1M = 50;

/** The design's planVar fallback (THB/month) for a plan with no active users yet. */
export const PLAN_VAR_FALLBACK: Record<string, number> = {
  free: 30, lite: 55, starter: 90, pro: 220, studio: 480, agency: 900, max: 1540, enterprise: 480,
};
export interface Ctx {
  cfg: CostConfig;
  modelDefaults: Record<string, ModelPrice>;
  sttDefaults: Record<string, SttModelPrice>;
  /** THB per month per plan; tiers without a sale price are 0. */
  prices: Record<string, number>;
  days: number;
  /** USD→THB used to price legacy rows (the backend's live rate). */
  fxRate: number;
  /** YYYY-MM-DD — which step of a dated price schedule legacy rows get. */
  today: string;
  /** THB we sell 1M rate-card tokens for (every plan). */
  sellPer1M: number;
  /** THB of vendor cost 1M tokens is pegged to (the rate card's reference). */
  referencePer1M?: number;
}

type PricingCtx = Pick<Ctx, "cfg" | "modelDefaults" | "fxRate" | "today">;
type SttCtx = Pick<Ctx, "cfg" | "sttDefaults" | "fxRate">;

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

/** The step of a dated price schedule in force on `day` (YYYY-MM-DD). */
export function priceAt(p: ModelPrice, day: string): ModelPrice {
  let cur = p;
  for (let i = 0; i < 10; i++) {
    if (cur.until && day > cur.until && cur.then) cur = cur.then;
    else break;
  }
  return cur;
}

type TokenLike = Pick<TokenRow, "model" | "input" | "output"> & Partial<TokenRow>;

/** Vendor units of the rows that carry no recorded cost. A row without the
 * cost fields at all (an older backend) is uncosted as a whole. */
function uncostedTokens(r: TokenLike): { input: number; output: number; cached: number } {
  if (r.cost_thb === undefined) return { input: r.input, output: r.output, cached: r.cached ?? 0 };
  return { input: r.uncosted_input ?? 0, output: r.uncosted_output ?? 0, cached: r.uncosted_cached ?? 0 };
}

/** USD of the legacy (uncosted) part of token rows. Aggregates hide the
 * prompt size of each call, so the long-prompt tier cannot apply here. */
export function uncostedTokenUsd(ctx: Pick<Ctx, "cfg" | "modelDefaults" | "today">, rows: TokenLike[]): number {
  let usd = 0;
  for (const r of rows) {
    const u = uncostedTokens(r);
    if (!u.input && !u.output) continue;
    const p = priceAt(modelPrice(ctx, r.model), ctx.today);
    const cached = Math.min(u.cached, u.input);
    const ratio = p.cached_ratio ?? 0.1;
    usd += ((u.input - cached) * p.input + cached * p.input * ratio + u.output * p.output) / 1e6;
  }
  return usd;
}

function recorded(rows: CostFacts[]): number {
  return rows.reduce((s, r) => s + Number(r.cost_thb ?? 0), 0);
}

/** Rate-card tokens the rows were charged. */
export function rateTokens(rows: CostFacts[]): number {
  return rows.reduce((s, r) => s + Number(r.tokens ?? 0), 0);
}

export function tokenCost(ctx: PricingCtx, rows: TokenLike[]): number {
  return recorded(rows) + uncostedTokenUsd(ctx, rows) * ctx.fxRate;
}

export function sttPrice(ctx: Pick<Ctx, "cfg" | "sttDefaults">, model: string): SttModelPrice {
  return ctx.cfg.stt[model] ?? ctx.sttDefaults[model] ?? FALLBACK_STT_PRICE;
}

/** Speech-to-text THB: recorded cost + legacy seconds at the per-hour price (keyterms assumed). */
export function sttCost(ctx: SttCtx, rows: SttRow[]): number {
  let thb = recorded(rows);
  for (const r of rows) {
    const secs = r.cost_thb === undefined ? r.seconds : r.uncosted_seconds ?? 0;
    if (secs <= 0) continue;
    const p = sttPrice(ctx, r.model);
    thb += ((secs * (p.usd_per_hour + p.keyterms_usd_per_hour)) / 3600) * ctx.fxRate;
  }
  return thb;
}

export function sttMinutes(rows: SttRow[]): number {
  return rows.reduce((s, r) => s + r.seconds, 0) / 60;
}

/** Token cost split into the design's task buckets. */
export function taskTokenCosts(ctx: PricingCtx, rows: TokenRow[]): Record<"cut" | "fx" | "style" | "other", number> {
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
  /** Rate-card tokens charged (AI + speech-to-text). */
  rateTokens: number;
  /** Vendor cost recorded on rows that carry rate-card tokens (cost per 1M basis). */
  recordedCost: number;
  sttCost: number;
  sttMin: number;
  extra: number;
  cost: number;
  planPrice: number;
  /** Subscription revenue in the period. */
  pays: number;
  /** Top-ups bought in the period (THB). */
  topup: number;
  /** Balance consumed by runs in the period (THB). */
  walletSpent: number;
  /** Unspent top-up balance right now (THB) — owed to the user as usage. */
  walletBalance: number;
  /** pays + topup. */
  revenue: number;
  profit: number;
}

export function userMoney(ctx: Ctx, u: UserFacts): UserMoney {
  const byTask = taskTokenCosts(ctx, u.tokens);
  const token = byTask.cut + byTask.fx + byTask.style + byTask.other;
  const sttCostThb = sttCost(ctx, u.stt);
  const extra = extraCost(ctx.cfg, u.clips, u.active, ctx.days);
  const cost = token + sttCostThb + extra;
  const planPrice = Number(ctx.prices[u.plan] || 0);
  const paying = !u.internal && u.active && u.subscription.live && planPrice > 0;
  const pays = paying ? (planPrice / vatDivisor(ctx.cfg)) * (ctx.days / 30) : 0;
  const topup = u.internal ? 0 : Number(u.topup_satang ?? 0) / 100 / vatDivisor(ctx.cfg);
  return {
    ...u,
    token,
    tasks: { stt: sttCostThb, extra, ...byTask },
    rateTokens: rateTokens(u.tokens) + rateTokens(u.stt),
    recordedCost: recorded(u.tokens.filter((t) => (t.tokens ?? 0) > 0)) + recorded(u.stt.filter((t) => (t.tokens ?? 0) > 0)),
    sttCost: sttCostThb,
    sttMin: sttMinutes(u.stt),
    extra,
    cost,
    planPrice,
    pays,
    topup,
    walletSpent: Number(u.wallet_spent_satang ?? 0) / 100,
    walletBalance: Number(u.wallet_balance_satang ?? 0) / 100,
    revenue: pays + topup,
    profit: pays + topup - cost,
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
  /** Subscription revenue. */
  tPays: number;
  /** Top-up revenue. */
  tTopup: number;
  /** tPays + tTopup. */
  tRevenue: number;
  /** Top-up balance consumed by runs in the period. */
  tWalletSpent: number;
  /** Unspent top-up balances of every counted account, right now. */
  tWalletBalance: number;
  /** Accounts that bought a top-up in the period. */
  topupBuyers: number;
  tToken: number;
  tStt: number;
  tExtra: number;
  /** Rate-card tokens charged in the period. */
  tRateTokens: number;
  tClips: number;
  tMin: number;
  tFailed: number;
  fixedMonth: number;
  otherFixed: number;
  costTotal: number;
  /** THB of vendor cost per 1M rate-card tokens (null before any charged usage). */
  costPer1M: number | null;
  /** Sell price per 1M minus costPer1M. */
  marginPer1M: number | null;
  profit: number;
  payers: number;
  freeCost: number;
  monthFactor: number;
  mPays: number;
  mTopup: number;
  mRevenue: number;
  mToken: number;
  mStt: number;
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
  const tTopup = sum((u) => u.topup);
  const tRevenue = tPays + tTopup;
  const tWalletSpent = sum((u) => u.walletSpent);
  const tWalletBalance = sum((u) => u.walletBalance);
  const topupBuyers = counted.filter((u) => u.topup > 0).length;
  const tToken = sum((u) => u.token);
  const tStt = sum((u) => u.sttCost);
  const tExtra = sum((u) => u.extra);
  const tRateTokens = sum((u) => u.rateTokens);
  const tRecorded = sum((u) => u.recordedCost);
  const tClips = sum((u) => u.clips);
  const tMin = sum((u) => u.sttMin);
  const tFailed = sum((u) => u.failed);

  const days = ctx.days;
  const fixedMonth = ctx.cfg.fixed.reduce((s, f) => s + Number(f.value || 0), 0);
  const otherFixed = (fixedMonth * days) / 30;
  // Speech-to-text is pay-as-you-go now: no prepaid package, nothing unused.
  const costTotal = tToken + tStt + tExtra + otherFixed;
  const costPer1M = tRateTokens > 0 ? (tRecorded / tRateTokens) * 1e6 : null;
  const marginPer1M = costPer1M === null ? null : ctx.sellPer1M - costPer1M;
  const profit = tRevenue - costTotal;
  const payers = counted.filter((u) => u.pays > 0).length;
  const freeCost = counted.filter((u) => !u.internal && u.planPrice === 0).reduce((s, u) => s + u.cost, 0);

  const monthFactor = 30 / days;
  const mPays = tPays * monthFactor;
  const mTopup = tTopup * monthFactor;
  const mRevenue = mPays + mTopup;
  const mToken = tToken * monthFactor;
  const mStt = tStt * monthFactor;
  const mExtra = tExtra * monthFactor;
  const monthlyCost = mToken + mStt + mExtra + fixedMonth;
  const monthlyProfit = mRevenue - monthlyCost;

  const ledger: LedgerLine[] = [
    { sign: "", label: "รายได้จากค่าสมาชิก", value: tPays, first: true },
    { sign: "+", label: "รายได้จากเติมเงิน", value: tTopup, first: true },
    { sign: "−", label: "โทเค็น AI", value: -tToken },
    { sign: "−", label: "ค่าถอดเสียง", value: -tStt },
    { sign: "−", label: "SMS และอีเมลต่อผู้ใช้", value: -tExtra },
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
  const deficit = Math.max(0, monthlyCost - mRevenue);

  const taskTotals: TaskCosts = { stt: 0, cut: 0, fx: 0, style: 0, extra: 0, other: 0 };
  for (const u of counted) for (const k of Object.keys(taskTotals) as TaskKey[]) taskTotals[k] += u.tasks[k];

  const wasted = counted.reduce((s, u) => s + (u.clips ? (u.cost / u.clips) * u.failed : 0), 0);
  const idle = counted.filter((u) => u.last_active_days === null || u.last_active_days >= 14).length;

  return {
    all, counted, tPays, tTopup, tRevenue, tWalletSpent, tWalletBalance, topupBuyers, tToken, tStt, tExtra, tRateTokens, tClips, tMin, tFailed, fixedMonth,
    otherFixed, costTotal, costPer1M, marginPer1M, profit, payers, freeCost, monthFactor, mPays, mTopup, mRevenue, mToken, mStt,
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
  profit: number;
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
  const fixedAuto = s.fixedMonth + internalCost;
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
    profit,
    needStarter: need("starter"),
    needPro: need("pro"),
  };
}

/** Variable cost of one bucket of the product-wide series. */
export function bucketVariableCost(ctx: Ctx, buckets: SeriesBucket[], activeUsers: number, daysInBucket: number): number {
  let cost = 0;
  let clips = 0;
  for (const b of buckets) {
    cost += tokenCost(ctx, b.tokens) + sttCost(ctx, b.stt);
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
  const fixedPerDay = s.fixedMonth / 30;
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
    return { key, revenue, cost: variable + s.fixedMonth * share };
  });
}

/** Cost of one project from its own usage rows (tokens + speech-to-text). */
export function jobCost(ctx: Ctx, job: JobFacts): number {
  return tokenCost(ctx, job.tokens) + sttCost(ctx, job.stt);
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
  "stt_minutes", "ai_tokens", "token_cost_thb", "last_active_days", "quota_window", "quota_pct",
  "topup_thb", "wallet_balance_thb",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function usersCsv(s: Summary): string {
  const lines = [CSV_HEAD.join(",")];
  for (const u of s.all) {
    lines.push(
      [
        csvCell(u.email), csvCell(u.plan), csvCell(u.active ? "yes" : "no"), csvCell(round2(u.pays)),
        csvCell(round2(u.cost)), csvCell(round2(u.profit)), csvCell(u.clips), csvCell(u.failed),
        csvCell(Math.round(u.sttMin)), csvCell(u.rateTokens), csvCell(round2(u.token)),
        csvCell(u.last_active_days), csvCell(u.quota_window ?? null), csvCell(u.quota_used_pct),
        csvCell(round2(u.topup)), csvCell(round2(u.walletBalance)),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\n") + "\n";
}

export function ctxFrom(data: DashboardData, cfg: CostConfig = data.cost_config, prices?: Record<string, number>): Ctx {
  return {
    cfg,
    modelDefaults: data.model_defaults,
    sttDefaults: data.stt_defaults ?? {},
    prices: prices ?? pricesFromSatang(data.prices.satang),
    days: data.period.days,
    fxRate: data.fx?.usd_thb ?? cfg.fx_rate,
    today: data.today,
    sellPer1M: data.billing_config?.sell_thb_per_1m ?? data.rate_card?.sell_thb_per_1m ?? DEFAULT_SELL_PER_1M,
    referencePer1M: data.billing_config?.reference_thb_per_1m ?? data.rate_card?.reference_thb_per_1m ?? DEFAULT_REFERENCE_PER_1M,
  };
}

/** A copy of `p` with the schedule step in force on `day` patched. */
export function patchStepAt(p: ModelPrice, day: string, patch: Partial<ModelPrice>): ModelPrice {
  if (p.until && day > p.until && p.then) return { ...p, then: patchStepAt(p.then, day, patch) };
  return { ...p, ...patch };
}

// ── estimate vs actual ──────────────────────────────────────────────────────

/** actual ÷ estimate of one run; null when there was no estimate or no work. */
export function runRatio(r: Pick<RunFacts, "estimate_tokens" | "actual_tokens">): number | null {
  return r.estimate_tokens > 0 && r.actual_tokens > 0 ? r.actual_tokens / r.estimate_tokens : null;
}

