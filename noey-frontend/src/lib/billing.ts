/**
 * Billing decisions, kept pure so the plan-button routing is unit-tested.
 * The backend creates every Stripe session; this site only decides WHICH
 * backend call a plan button makes and renders `GET /billing/me`.
 */
import type { PaidTier } from "./plans";

export interface PaymentMethodSummary {
  brand: string;
  last4: string;
}

export interface BillingMe {
  plan: string;
  status: string | null;
  lookup_key: string | null;
  current_period_end: string | number | null;
  cancel_at_period_end: boolean;
  payment_method: PaymentMethodSummary | null;
  billing_enabled: boolean;
}

export function normalizeBillingMe(body: unknown): BillingMe | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.plan !== "string") return null;
  const pm = raw.payment_method as Record<string, unknown> | null | undefined;
  const periodEnd = raw.current_period_end;
  return {
    plan: raw.plan,
    status: typeof raw.status === "string" ? raw.status : null,
    lookup_key: typeof raw.lookup_key === "string" ? raw.lookup_key : null,
    current_period_end: typeof periodEnd === "string" || typeof periodEnd === "number" ? periodEnd : null,
    cancel_at_period_end: raw.cancel_at_period_end === true,
    payment_method:
      pm && typeof pm === "object" && typeof pm.brand === "string" && typeof pm.last4 === "string"
        ? { brand: pm.brand, last4: pm.last4 }
        : null,
    billing_enabled: raw.billing_enabled !== false,
  };
}

/**
 * Subscription statuses that keep the paid tier — the owner's rule, mirrored
 * from the backend (`packages/billing/catalog.py` LIVE_STATUSES). Anything
 * else (incomplete, incomplete_expired, unpaid, paused, canceled) counts as
 * the free plan and starts over at Checkout.
 */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const;

export function hasLiveSubscription(billing: BillingMe | null | undefined): boolean {
  return !!billing?.status && (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(billing.status);
}

export type PlanDecision =
  | { kind: "signup"; path: string }
  | { kind: "checkout"; lookupKey: string }
  | { kind: "change-plan"; lookupKey: string }
  | { kind: "already-on-plan" }
  /** Same plan, but its cancellation is scheduled: "ใช้แพลนนี้ต่อ" (resume) is the way back. */
  | { kind: "resume-instead" }
  | { kind: "billing-unavailable" };

export interface PlanDecisionInput {
  tier: PaidTier;
  lookupKey: string;
  signedIn: boolean;
  /** `GET /billing/me`, or null when it failed / does not exist yet. */
  billing: BillingMe | null;
}

/**
 * The plan-button rule (home, pricing, upgrade dialog):
 *   logged out                  -> /signup?plan=<tier>
 *   billing not configured      -> calm "not available" notice
 *   live subscription, same plan -> nothing to buy (or "resume" if it is ending)
 *   live subscription            -> change-plan (Stripe's hosted confirm page)
 *   no live subscription         -> checkout
 * "Same plan" compares tiers, as the backend does (a grandfathered price keeps
 * its tier even without the current lookup key).
 */
export function decidePlanAction(input: PlanDecisionInput): PlanDecision {
  if (!input.signedIn) return { kind: "signup", path: `/signup?plan=${input.tier}` };
  if (!input.billing || !input.billing.billing_enabled) return { kind: "billing-unavailable" };
  if (hasLiveSubscription(input.billing)) {
    const samePlan = input.billing.plan === input.tier || input.billing.lookup_key === input.lookupKey;
    if (samePlan) return input.billing.cancel_at_period_end ? { kind: "resume-instead" } : { kind: "already-on-plan" };
    return { kind: "change-plan", lookupKey: input.lookupKey };
  }
  return { kind: "checkout", lookupKey: input.lookupKey };
}

/**
 * The backend answers 409 when our guess about the subscription was stale
 * (checkout: "already subscribed", change-plan: "no live subscription").
 * Retry once with the other endpoint instead of surfacing an error.
 */
export function alternateForConflict(decision: PlanDecision): PlanDecision | null {
  if (decision.kind === "checkout") return { kind: "change-plan", lookupKey: decision.lookupKey };
  if (decision.kind === "change-plan") return { kind: "checkout", lookupKey: decision.lookupKey };
  return null;
}

const CARD_BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  jcb: "JCB",
  unionpay: "UnionPay",
  discover: "Discover",
  diners: "Diners Club",
};

export function formatCard(method: PaymentMethodSummary | null | undefined): string | null {
  if (!method) return null;
  const brand = CARD_BRANDS[method.brand.toLowerCase()] ?? method.brand;
  return `${brand} •••• ${method.last4}`;
}

const STATUS_LABELS: Record<string, string> = {
  active: "ใช้งานอยู่",
  trialing: "อยู่ในช่วงทดลองใช้",
  past_due: "ตัดบัตรไม่สำเร็จ ระบบจะลองตัดอีกครั้ง",
  unpaid: "ค้างชำระ",
  paused: "พักการใช้งาน",
  incomplete: "รอยืนยันการชำระเงิน",
  incomplete_expired: "การชำระเงินหมดเวลา",
  canceled: "ยกเลิกแล้ว",
};

export function subscriptionStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return STATUS_LABELS[status] ?? status;
}

/** Still on the paid plan, but the last charge failed: the card needs fixing. */
export function needsPaymentAttention(status: string | null | undefined): boolean {
  return status === "past_due";
}

/**
 * A subscription exists but no longer holds the paid plan (payment never
 * completed, or stopped): the backend has put the account back on free.
 */
export function subscriptionLapsed(status: string | null | undefined): boolean {
  return status === "unpaid" || status === "paused" || status === "incomplete" || status === "incomplete_expired";
}
