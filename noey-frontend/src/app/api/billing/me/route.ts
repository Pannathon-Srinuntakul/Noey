import { NextResponse } from "next/server";
import { normalizeBillingMe } from "@/lib/billing";
import { authedApi } from "@/lib/server/session";

/**
 * GET — what /checkout/success polls while Stripe's webhook reaches the
 * backend. Returns only the fields that page renders (a DTO, not the raw
 * backend body). A GET changes nothing, and SameSite=Lax session cookies are
 * not sent on cross-site fetches, so no Origin check is needed here.
 */
export async function GET() {
  const outcome = await authedApi<unknown>("/billing/me", {}, { mutable: true });
  const headers = { "Cache-Control": "private, no-store" };
  if (outcome.kind === "unauthenticated") return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers });
  if (outcome.kind !== "ok") return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  const billing = outcome.result.ok ? normalizeBillingMe(outcome.result.data) : null;
  if (!billing) return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  return NextResponse.json(
    {
      plan: billing.plan,
      status: billing.status,
      cancel_at_period_end: billing.cancel_at_period_end,
      current_period_end: billing.current_period_end,
    },
    { headers },
  );
}
