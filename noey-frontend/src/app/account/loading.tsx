import { AccountBodySkeleton } from "@/components/account/AccountSkeleton";

/** Switching account tabs: only the panel's contents wait; the greeting and the tabs stay. */
export default function Loading() {
  return <AccountBodySkeleton />;
}
