/**
 * Shapes returned by the backend's /admin/* endpoints
 * (backend/services/api/routers/admin.py, packages/admin/metrics.py).
 * The backend returns FACTS only; every baht is computed in lib/money.ts.
 */

export type Tier = "free" | "lite" | "starter" | "pro" | "studio" | "agency" | "max" | "enterprise";

export interface TokenRow {
  model: string;
  feature: string;
  input: number;
  output: number;
  calls: number;
}

export interface SttRow {
  model: string;
  seconds: number;
}

export interface Subscription {
  status: string | null;
  live: boolean;
  current_period_end: string | null;
  cancel_at_period_end?: boolean;
}

export interface UserFacts {
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
}

export interface SeriesBucket {
  key: string;
  internal: boolean;
  tokens: Array<{ model: string; input: number; output: number }>;
  stt: SttRow[];
  clips: number;
}

export interface ModelPrice {
  input: number;
  output: number;
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
  stt: { model: string; credits_per_hour: number; monthly_price: number; credits: number };
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
  stt_rates: Record<string, number>;
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
}

export interface PlanPrices {
  source: "stripe" | "mock";
  billing_enabled: boolean;
  satang: Record<string, number>;
  max_thb: number;
  changed?: string[];
}
