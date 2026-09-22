/**
 * Shapes returned by the backend's /admin/* endpoints
 * (backend/services/api/routers/admin.py, packages/admin/metrics.py).
 * The backend returns FACTS only; every baht is computed in lib/money.ts.
 * Since 2026-09-22 each usage row records its own vendor cost (`cost_thb`)
 * and the rate-card tokens the user was charged (`tokens`); rows from before
 * that come back as `uncosted_*` vendor units for money.ts to price.
 */

export type Tier = "free" | "lite" | "starter" | "pro" | "studio" | "agency" | "max" | "enterprise";

/** Vendor cost recorded on the rows + the vendor units of legacy rows without one. */
export interface CostFacts {
  /** Rate-card tokens charged (0 on legacy rows). */
  tokens?: number;
  /** Σ recorded vendor cost, THB. */
  cost_thb?: number;
}

export interface TokenRow extends CostFacts {
  model: string;
  feature: string;
  input: number;
  output: number;
  calls: number;
  cached?: number;
  uncosted_input?: number;
  uncosted_output?: number;
  uncosted_cached?: number;
  failed_calls?: number;
}

export interface SttRow extends CostFacts {
  model: string;
  seconds: number;
  uncosted_seconds?: number;
}

export interface Subscription {
  status: string | null;
  live: boolean;
  current_period_end: string | null;
  cancel_at_period_end?: boolean;
}

export type WindowKey = "five_hour" | "weekly" | "monthly";

/** One enforced limit window with REAL rate-card tokens (admin only — users
 * only ever see the percentage). */
export interface LimitWindow {
  key: WindowKey;
  limit_tokens: number;
  used_tokens: number;
  reserved_tokens: number;
  /** Includes open reservations; may exceed 100. */
  used_pct: number;
  active: boolean;
  /** UTC ISO; null while the window waits for the next use. */
  resets_at: string | null;
}

/** packages/admin/metrics.py window_facts — per user on the dashboard and in `UserDetail.limits`. */
export interface LimitFacts {
  effective_plan: string;
  unlimited: boolean;
  windows: LimitWindow[];
  quota_window: WindowKey | null;
  quota_limit_tokens: number;
  quota_used_tokens: number;
  quota_used_pct: number | null;
  wallet_balance_satang: number;
  pending_plan: { plan: string; at: string | null } | null;
  grace_until: string | null;
}

export interface UserFacts extends Partial<LimitFacts> {
  id: number;
  email: string;
  display_name: string | null;
  plan: string;
  internal: boolean;
  active: boolean;
  email_verified: boolean;
  created_at: string | null;
  subscription: Subscription;
  quota_limit_tokens: number;
  usage_reset_at: string | null;
  tokens: TokenRow[];
  stt: SttRow[];
  clips: number;
  failed: number;
  projects: number;
  engine_pro_pct: number | null;
  precision_high_pct: number | null;
  last_active_at: string | null;
  last_active_days: number | null;
  quota_used_tokens: number;
  quota_used_pct: number | null;
  /** Top-ups bought in the period (paid lots, gross satang). */
  topup_satang?: number;
  topups?: number;
  /** Balance consumed by runs in the period (debits net of refunds), satang. */
  wallet_spent_satang?: number;
}

export interface SeriesBucket {
  key: string;
  internal: boolean;
  tokens: Array<Omit<TokenRow, "feature" | "calls">>;
  stt: SttRow[];
  clips: number;
}

/** USD per 1M vendor tokens (packages/admin/cost_config.py). */
export interface ModelPrice {
  input: number;
  output: number;
  /** A dearer tier for a prompt above `long_threshold` tokens; the whole call is billed at it. */
  input_long?: number | null;
  output_long?: number | null;
  long_threshold?: number | null;
  /** Cached input costs this share of `input`. */
  cached_ratio?: number;
  /** This price holds THROUGH this day (YYYY-MM-DD); `then` applies after. */
  until?: string | null;
  then?: ModelPrice | null;
}

/** Pay-as-you-go speech-to-text, USD per hour of billed audio. */
export interface SttModelPrice {
  usd_per_hour: number;
  keyterms_usd_per_hour: number;
}

export interface FixedItem {
  id: string;
  label: string;
  value: number;
}

export interface PerUserItem {
  id: string;
  label: string;
  value: number;
  basis: "user" | "clip";
}

export interface CostConfig {
  fx_rate: number;
  models: Record<string, ModelPrice>;
  stt: Record<string, SttModelPrice>;
  fixed: FixedItem[];
  per_user: PerUserItem[];
  vat_included: boolean;
  include_internal: boolean;
}

export interface DashboardData {
  period: { from: string; to: string; days: number };
  today: string;
  chart: { from: string; to: string; days: number };
  months: string[];
  month_to_date_days: number;
  users: UserFacts[];
  daily: SeriesBucket[];
  monthly: SeriesBucket[];
  models_seen: Array<{ model: string; features: string[] }>;
  cost_config: CostConfig;
  model_defaults: Record<string, ModelPrice>;
  stt_defaults: Record<string, SttModelPrice>;
  rate_card: RateCard;
  /** The USD→THB rate new usage is priced with right now. */
  fx: { usd_thb: number; source: string };
  billing_config?: BillingConfigView;
  circuit_breaker?: CircuitBreaker;
  estimate_accuracy?: EstimateAccuracy;
  prices: { source: "stripe" | "mock"; satang: Record<string, number>; billing_enabled: boolean };
  plan_values: string[];
  paid_tiers: string[];
  admin_user_id: number;
}

export interface JobFacts {
  uid: string;
  name: string | null;
  mode: string;
  status: string;
  engine: string | null;
  precision: string | null;
  footage_sec: number | null;
  created_at: string | null;
  tokens: TokenRow[];
  stt: SttRow[];
}

export interface UserDetail {
  user_id: number;
  jobs: JobFacts[];
  subscription: Subscription;
  limits?: LimitFacts;
  wallet?: WalletSummary;
  /** The last 50 paid runs, newest first. */
  runs?: RunFacts[];
  /** The last 90 days for this user. */
  estimate_accuracy?: EstimateAccuracy;
  /** Runs that failed on our side in the last 30 days and what they cost us. */
  failed_runs_30d?: FailedRunsSummary;
}

/**
 * The user's runs that ended ``our_failure`` (GET /admin/users/{id}). The first
 * few a day are refunded; past the daily allowance they are charged what they
 * used (``charged_after_cap_runs``) — a high count means someone may be burning
 * vendor spend through failures.
 */
export interface FailedRunsSummary {
  since: string;
  runs: number;
  refunded_runs: number;
  charged_after_cap_runs: number;
  /** Rate-card tokens of the refunded runs (admin-only figure). */
  refunded_tokens: number;
  cost_thb: number;
}

/** ``reversal``: a top-up refunded or disputed at the payment provider, taken back. */
export type WalletEntryKind = "purchase" | "debit" | "refund" | "expire" | "adjust" | "reversal";

/** The GET /wallet/me body — baht in satang, never tokens. */
export interface WalletSummary {
  balance_satang: number;
  reserved_satang: number;
  lots: Array<{ remaining_satang: number; expires_at: string | null }>;
  history: Array<{ kind: WalletEntryKind; amount_satang: number; created_at: string | null }>;
  packs: number[];
  methods: string[];
}

/** One paid run (core.ai_runs) with estimate / actual / charged and real cost. */
export interface RunFacts {
  id: string;
  kind: string;
  mode: string | null;
  engine: string | null;
  precision: string | null;
  reference_id: string | null;
  status: string;
  outcome: string | null;
  unlimited: boolean;
  media_sec: number;
  estimate_tokens: number;
  ceiling_tokens: number;
  actual_tokens: number;
  charged_tokens: number | null;
  charged_wallet_satang: number | null;
  cost_thb: number;
  created_at: string | null;
  settled_at: string | null;
}

export interface AccuracyStats {
  runs: number;
  /** actual ÷ estimate. */
  median_ratio: number | null;
  p90_ratio: number | null;
  over_ceiling: number;
  limit_stops: number;
  estimate_tokens: number;
  actual_tokens: number;
}

export interface EstimateAccuracy {
  from: string;
  to: string;
  user_id: number | null;
  overall: AccuracyStats;
  by_kind: Array<AccuracyStats & { kind: string; precision: string }>;
  estimator_versions: string[];
}

/** GET/PUT /admin/billing-config. Reference + sell are display/margin only;
 * what users are charged is fixed in code (`charged_sell_thb_per_1m`). */
export interface BillingConfigView {
  reference_thb_per_1m: number;
  sell_thb_per_1m: number;
  topup_thb_per_1m: number;
  charged_sell_thb_per_1m: number;
  rate_card: RateCard;
}

/** GET/PUT /admin/circuit-breaker — the daily AI spend cap (UTC day). */
export interface CircuitBreaker {
  enabled: boolean;
  daily_cap_thb: number;
  /** In-flight calls stop at cap × this; new jobs are refused at the cap. */
  hard_stop_ratio: number;
  alert_email: string | null;
  day: string;
  spend_today_thb: number;
  tripped: boolean;
  hard_stopped: boolean;
}

export type BreakerSettings = Pick<CircuitBreaker, "enabled" | "daily_cap_thb" | "hard_stop_ratio" | "alert_email">;

export interface PlanPrices {
  source: "stripe" | "mock";
  billing_enabled: boolean;
  satang: Record<string, number>;
  max_thb: number;
  changed?: string[];
}

export interface RateCard {
  version: string;
  llm: Record<string, { input: number; output: number; input_long: number | null; output_long: number | null; long_threshold: number | null }>;
  cached_ratio: number;
  stt_per_sec: number;
  reference_thb_per_1m: number;
  sell_thb_per_1m: number;
  topup_thb_per_1m: number;
}

export interface FxView {
  usd_thb: number;
  /** override | open.er-api.com | frankfurter.app | cost_config | default */
  source: string;
  override: number | null;
  fetched: { usd_thb: number; date: string; source: string } | null;
  history: Array<{ date: string; usd_thb: number; source: string }>;
  band: [number, number];
}

export type Vendor = "gemini" | "elevenlabs";

export interface VendorReconciliation {
  vendor: Vendor;
  rows: number;
  units: Record<string, number>;
  recorded_thb: number;
  attributed_thb: number;
  unattributed_thb: number;
  unpriced_rows: number;
  invoice_thb: number | null;
  invoice_note: string | null;
  gap_pct: number | null;
  warn: boolean;
}

export interface Reconciliation {
  month: string;
  warn_pct: number;
  vendors: VendorReconciliation[];
}
