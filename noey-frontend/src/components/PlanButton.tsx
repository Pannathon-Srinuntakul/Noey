"use client";

import { useActionState } from "react";
import { startPlanAction } from "@/app/actions/billing";
import type { ActionState } from "@/lib/messages";
import type { PaidTier } from "@/lib/plans";
import { PendingButton } from "./ui/PendingButton";

/**
 * A paid-plan button. The Server Action decides where it goes (signup, or
 * the billing page's plan dialog), so the same button works for visitors and
 * subscribers on a fully static page.
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
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(startPlanAction, undefined);
  return (
    <form action={action} className="plan-form">
      <input type="hidden" name="plan" value={tier} />
      <PendingButton
        className={`btn ${primary ? "btn-primary" : "btn-secondary"} btn-block`}
        disabled={disabled || pending}
        busy={pending}
        busyLabel="กำลังดำเนินการ…"
      >
        {label}
      </PendingButton>
      {state?.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
