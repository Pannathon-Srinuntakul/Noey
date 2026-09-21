"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  alternateForConflict,
  decidePlanAction,
  normalizeBillingMe,
  type BillingMe,
  type PlanDecision,
} from "@/lib/billing";
import { MSG, type ActionState } from "@/lib/messages";
import { isPaidTier, lookupKeyFor } from "@/lib/plans";
import { isSafeExternalRedirect } from "@/lib/redirect-url";
import { getPriceTable } from "@/lib/server/prices";
import { authedApi, readSessionTokens } from "@/lib/server/session";
import { loginPathFor } from "@/lib/session";

type SessionUrl = { url: string } | { error: string } | { unauthenticated: true };

/** POST /billing/checkout or /billing/change-plan -> Stripe-hosted URL. */
async function createStripeSession(decision: Extract<PlanDecision, { kind: "checkout" | "change-plan" }>): Promise<SessionUrl & { status?: number }> {
  const path = decision.kind === "checkout" ? "/billing/checkout" : "/billing/change-plan";
  const outcome = await authedApi<{ url?: unknown }>(path, { method: "POST", body: { lookup_key: decision.lookupKey } }, { mutable: true });
  if (outcome.kind === "unauthenticated") return { unauthenticated: true };
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok && isSafeExternalRedirect(result.data?.url)) return { url: result.data.url as string };
  if (result.status === 503 || result.status === 404) return { error: MSG.billingUnavailable, status: result.status };
  if (result.status === 429) return { error: MSG.rateLimited, status: result.status };
  return { error: MSG.generic, status: result.status };
}

/** Run a plan decision, retrying once with the other endpoint on 409. */
async function runPlanDecision(decision: PlanDecision): Promise<SessionUrl> {
  switch (decision.kind) {
    case "signup":
      return { url: decision.path };
    case "already-on-plan":
      return { error: MSG.alreadyOnPlan };
    case "resume-instead":
      return { error: MSG.resumeInstead };
    case "billing-unavailable":
      return { error: MSG.billingUnavailable };
  }
  const first = await createStripeSession(decision);
  if ("status" in first && first.status === 409) {
    const alternate = alternateForConflict(decision);
    if (alternate && (alternate.kind === "checkout" || alternate.kind === "change-plan")) {
      const second = await createStripeSession(alternate);
      // Both refused: the subscription exists but cannot be changed here right now.
      if ("status" in second && second.status === 409) return { error: MSG.planChangeBlocked };
      return second;
    }
    return { error: MSG.planChangeBlocked };
  }
  return first;
}

/**
 * Every paid-plan button (home, /pricing, upgrade dialog, post-signup):
 *   logged out -> /signup?plan=<tier>; otherwise checkout or change-plan.
 */
export async function choosePlanAction(_previous: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const tier = formData.get("plan");
  if (!isPaidTier(tier)) return { error: "เลือกแพลนที่ต้องการก่อน" };

  const tokens = await readSessionTokens();
  if (!tokens.access && !tokens.refresh) redirect(`/signup?plan=${tier}`);

  const table = await getPriceTable({ fallbackOnError: true });
  const lookupKey = lookupKeyFor(table, tier);

  const me = await authedApi<unknown>("/billing/me", {}, { mutable: true });
  if (me.kind === "unauthenticated") redirect(loginPathFor(`/account/billing?plan=${tier}`));
  if (me.kind !== "ok") return { error: MSG.generic };
  if (me.result.status === 429) return { error: MSG.rateLimited };
  const billing: BillingMe | null = me.result.ok ? normalizeBillingMe(me.result.data) : null;

  const outcome = await runPlanDecision(decidePlanAction({ tier, lookupKey, signedIn: true, billing }));
  if ("unauthenticated" in outcome) redirect(loginPathFor(`/account/billing?plan=${tier}`));
  if ("url" in outcome) redirect(outcome.url);
  return { error: outcome.error };
}

/** Stripe Customer Portal: card, invoices, receipts. */
export async function openPortalAction(): Promise<ActionState> {
  const outcome = await authedApi<{ url?: unknown }>("/billing/portal", { method: "POST" }, { mutable: true });
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/billing"));
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok && isSafeExternalRedirect(result.data?.url)) redirect(result.data.url as string);
  if (result.status === 409) return { error: MSG.noBillingCustomer };
  if (result.status === 503 || result.status === 404) return { error: MSG.billingUnavailable };
  if (result.status === 429) return { error: MSG.rateLimited };
  return { error: MSG.generic };
}

async function postSubscriptionChange(path: "/billing/cancel" | "/billing/resume", success: string): Promise<ActionState> {
  const outcome = await authedApi<unknown>(path, { method: "POST" }, { mutable: true });
  if (outcome.kind === "unauthenticated") redirect(loginPathFor("/account/billing"));
  if (outcome.kind !== "ok") return { error: MSG.generic };
  const result = outcome.result;
  if (result.ok) {
    // Re-render /account/billing in this same response so the new state shows.
    refresh();
    return { ok: true, success };
  }
  if (result.status === 503 || result.status === 404) return { error: MSG.billingUnavailable };
  if (result.status === 409) return { error: "ไม่พบแพลนที่ชำระเงินอยู่ รีเฟรชหน้านี้แล้วลองอีกครั้ง" };
  if (result.status === 429) return { error: MSG.rateLimited };
  return { error: MSG.generic };
}

export async function cancelPlanAction(): Promise<ActionState> {
  return postSubscriptionChange("/billing/cancel", "ยกเลิกแพลนแล้ว ใช้งานต่อได้จนจบรอบบิลที่จ่ายไปแล้ว");
}

export async function resumePlanAction(): Promise<ActionState> {
  return postSubscriptionChange("/billing/resume", "ใช้แพลนต่อแล้ว ระบบจะต่ออายุตามรอบบิลเดิม");
}
