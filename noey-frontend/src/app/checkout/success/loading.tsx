import { StatusSkeleton } from "@/components/shell/StatusSkeleton";

/** Back from Stripe, while the plan is read (CheckoutStatus's own task name). */
export default function Loading() {
  return <StatusSkeleton task="การชำระเงิน" />;
}
