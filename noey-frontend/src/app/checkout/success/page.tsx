import type { Metadata } from "next";
import { CheckoutStatus } from "@/components/account/CheckoutStatus";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";
import { APP_URL } from "@/lib/site";

// Stripe returns here with ?session_id=… (protected by Proxy; noindex).
export const metadata: Metadata = privatePageMetadata("ชำระเงิน");

export default async function CheckoutSuccessPage() {
  // First look server-side; the client keeps polling if the webhook is still on its way.
  const { billing } = await loadAccountData("/checkout/success", { billing: true });
  const initial = billing ? { plan: billing.plan, status: billing.status } : null;

  return (
    <main id="main" className="container page">
      <p className="eyebrow">การชำระเงิน</p>
      <h1 className="page-title">ขอบคุณที่อัปเกรดแพลน</h1>
      <CheckoutStatus initial={initial} appUrl={APP_URL} />
    </main>
  );
}
