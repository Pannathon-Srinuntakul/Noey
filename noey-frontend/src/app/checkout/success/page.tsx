import type { Metadata } from "next";
import { CheckoutStatus } from "@/components/account/CheckoutStatus";
import { privatePageMetadata } from "@/lib/seo";
import { loadAccountData } from "@/lib/server/account-data";

// Stripe returns here with ?session_id=… (protected by Proxy; noindex).
export const metadata: Metadata = privatePageMetadata("ชำระเงิน");

export default async function CheckoutSuccessPage() {
  // First look server-side; the client keeps polling if the webhook is still on its way.
  const { billing } = await loadAccountData("/checkout/success", { billing: true });
  const initial = billing ? { plan: billing.plan, status: billing.status } : null;

  // The title ("ขอบคุณที่อัปเกรดแพลน") and eyebrow live on CheckoutStatus's status card.
  return (
    <main id="main" className="status-page page-top">
      <div className="wrap">
        <CheckoutStatus initial={initial} />
      </div>
    </main>
  );
}
