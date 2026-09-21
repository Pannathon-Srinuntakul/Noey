import { describe, expect, it } from "vitest";
import {
  LIVE_SUBSCRIPTION_STATUSES,
  alternateForConflict,
  decidePlanAction,
  formatCard,
  hasLiveSubscription,
  needsPaymentAttention,
  normalizeBillingMe,
  subscriptionLapsed,
  type BillingMe,
} from "./billing";

const freeUser: BillingMe = {
  plan: "free",
  status: null,
  lookup_key: null,
  current_period_end: null,
  cancel_at_period_end: false,
  payment_method: null,
  billing_enabled: true,
};

const proSubscriber: BillingMe = {
  ...freeUser,
  plan: "pro",
  status: "active",
  lookup_key: "noey_pro_monthly",
  current_period_end: 1790000000,
  payment_method: { brand: "visa", last4: "4242" },
};

describe("decidePlanAction (plan buttons on home, pricing and the upgrade dialog)", () => {
  it("sends logged-out visitors to signup with the plan", () => {
    expect(decidePlanAction({ tier: "pro", lookupKey: "noey_pro_monthly", signedIn: false, billing: null })).toEqual({
      kind: "signup",
      path: "/signup?plan=pro",
    });
  });

  it("goes to checkout when signed in without a live subscription", () => {
    expect(decidePlanAction({ tier: "lite", lookupKey: "noey_lite_monthly", signedIn: true, billing: freeUser })).toEqual({
      kind: "checkout",
      lookupKey: "noey_lite_monthly",
    });
  });

  it("treats every status outside the backend's live set as the free plan (checkout)", () => {
    // Mirrors backend packages/billing/catalog.py LIVE_STATUSES = {active, trialing, past_due}.
    for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
      const billing = { ...proSubscriber, plan: "free", status };
      expect(decidePlanAction({ tier: "pro", lookupKey: "noey_pro_monthly", signedIn: true, billing }).kind).toBe("checkout");
    }
  });

  it("goes to change-plan when a live subscription exists", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      const billing = { ...proSubscriber, status };
      expect(
        decidePlanAction({ tier: "studio", lookupKey: "noey_studio_monthly", signedIn: true, billing }),
      ).toEqual({ kind: "change-plan", lookupKey: "noey_studio_monthly" });
    }
  });

  it("does not send a subscriber to pay for the plan they already have", () => {
    expect(decidePlanAction({ tier: "pro", lookupKey: "noey_pro_monthly", signedIn: true, billing: proSubscriber })).toEqual({
      kind: "already-on-plan",
    });
  });

  it("compares plans by tier, like the backend (a grandfathered price keeps its tier)", () => {
    const billing = { ...proSubscriber, lookup_key: "some_old_pro_price" };
    expect(decidePlanAction({ tier: "pro", lookupKey: "noey_pro_monthly", signedIn: true, billing }).kind).toBe("already-on-plan");
  });

  it("points a subscriber whose same plan is ending to resume, not to a new purchase", () => {
    const billing = { ...proSubscriber, cancel_at_period_end: true };
    expect(decidePlanAction({ tier: "pro", lookupKey: "noey_pro_monthly", signedIn: true, billing }).kind).toBe("resume-instead");
    expect(decidePlanAction({ tier: "studio", lookupKey: "noey_studio_monthly", signedIn: true, billing }).kind).toBe("change-plan");
  });

  it("reports billing as unavailable when not configured or unknown", () => {
    const disabled = { ...freeUser, billing_enabled: false };
    expect(decidePlanAction({ tier: "pro", lookupKey: "k", signedIn: true, billing: disabled }).kind).toBe("billing-unavailable");
    expect(decidePlanAction({ tier: "pro", lookupKey: "k", signedIn: true, billing: null }).kind).toBe("billing-unavailable");
  });

  it("swaps endpoints once when the backend answers 409", () => {
    expect(alternateForConflict({ kind: "checkout", lookupKey: "k" })).toEqual({ kind: "change-plan", lookupKey: "k" });
    expect(alternateForConflict({ kind: "change-plan", lookupKey: "k" })).toEqual({ kind: "checkout", lookupKey: "k" });
    expect(alternateForConflict({ kind: "already-on-plan" })).toBeNull();
  });
});

describe("subscription status helpers", () => {
  it("asks for a card fix only while the paid plan is still held (past_due)", () => {
    expect(needsPaymentAttention("past_due")).toBe(true);
    for (const status of ["active", "unpaid", "incomplete", null]) expect(needsPaymentAttention(status)).toBe(false);
  });

  it("recognises subscriptions that dropped the account back to free", () => {
    for (const status of ["unpaid", "paused", "incomplete", "incomplete_expired"]) expect(subscriptionLapsed(status)).toBe(true);
    for (const status of ["active", "trialing", "past_due", "canceled", null]) expect(subscriptionLapsed(status)).toBe(false);
  });

  it("keeps the live set identical to the backend's", () => {
    expect([...LIVE_SUBSCRIPTION_STATUSES]).toEqual(["active", "trialing", "past_due"]);
  });
});

describe("normalizeBillingMe", () => {
  it("reads the documented shape", () => {
    const parsed = normalizeBillingMe({
      plan: "pro",
      status: "active",
      lookup_key: "noey_pro_monthly",
      current_period_end: "2026-10-21T00:00:00Z",
      cancel_at_period_end: false,
      payment_method: { brand: "mastercard", last4: "4444" },
      billing_enabled: true,
    });
    expect(parsed?.payment_method).toEqual({ brand: "mastercard", last4: "4444" });
    expect(hasLiveSubscription(parsed)).toBe(true);
  });

  it("tolerates nulls and rejects non-contract bodies", () => {
    expect(normalizeBillingMe({ plan: "free", status: null, payment_method: null })?.billing_enabled).toBe(true);
    expect(normalizeBillingMe({ detail: "Not Found" })).toBeNull();
    expect(hasLiveSubscription(null)).toBe(false);
  });
});

describe("formatCard", () => {
  it("shows brand and last four digits only", () => {
    expect(formatCard({ brand: "visa", last4: "4242" })).toBe("Visa •••• 4242");
    expect(formatCard({ brand: "somecard", last4: "0000" })).toBe("somecard •••• 0000");
    expect(formatCard(null)).toBeNull();
  });
});
