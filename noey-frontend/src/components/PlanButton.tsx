"use client";

import { useActionState } from "react";
import { choosePlanAction } from "@/app/actions/billing";
import type { ActionState } from "@/lib/messages";
import type { PaidTier } from "@/lib/plans";

/**
 * A paid-plan button. The Server Action decides where it goes (signup,
 * Checkout, or Stripe's change-plan page), so the same button works for
 * visitors and subscribers on a fully static page.
 */
export function PlanButton({
  tier,
  label,
  primary = false,
  disabled = false,
}: {
  tier: PaidTier;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(choosePlanAction, undefined);
  return (
    <form action={action} className="plan-form">
      <input type="hidden" name="plan" value={tier} />
      <button
        type="submit"
        className={`btn ${primary ? "btn-primary" : "btn-secondary"} btn-block`}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
      >
        {pending ? "กำลังดำเนินการ…" : label}
      </button>
      {state?.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
