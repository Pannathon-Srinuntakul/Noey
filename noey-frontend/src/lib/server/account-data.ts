import "server-only";
import { normalizeBillingMe, type BillingMe } from "../billing";
import type { UsageMe } from "./api";
import { authedApi, resolvePageOutcome } from "./session";

export interface StorageOut {
  used_bytes: number;
  quota_bytes: number;
  plan: string;
  project_count: number;
}

/**
 * Signed-in data for the account tabs, fetched in parallel. Each part is
 * independent: `null` means that endpoint failed or does not exist yet (e.g.
 * /billing/me before the billing backend ships), and the page shows only
 * what it really has.
 */
export async function loadAccountData(
  path: string,
  parts: { usage?: boolean; billing?: boolean; storage?: boolean },
): Promise<{ usage: UsageMe | null; billing: BillingMe | null; billingMissing: boolean; storage: StorageOut | null }> {
  const [usageOutcome, billingOutcome, storageOutcome] = await Promise.all([
    parts.usage ? authedApi<UsageMe>("/usage/me", {}, { mutable: false }) : null,
    parts.billing ? authedApi<unknown>("/billing/me", {}, { mutable: false }) : null,
    parts.storage ? authedApi<StorageOut>("/videos/storage", { timeoutMs: 6_000 }, { mutable: false }) : null,
  ]);

  const usageResult = usageOutcome ? resolvePageOutcome(usageOutcome, path) : null;
  const billingResult = billingOutcome ? resolvePageOutcome(billingOutcome, path) : null;
  const storageResult = storageOutcome ? resolvePageOutcome(storageOutcome, path) : null;

  const storage =
    storageResult?.ok && typeof storageResult.data?.used_bytes === "number" && typeof storageResult.data?.quota_bytes === "number"
      ? storageResult.data
      : null;

  return {
    usage: usageResult?.ok ? usageResult.data : null,
    billing: billingResult?.ok ? normalizeBillingMe(billingResult.data) : null,
    // 404/503 = billing not deployed or not configured (a calm notice, not an error).
    billingMissing: !!billingResult && !billingResult.ok && (billingResult.status === 404 || billingResult.status === 503),
    storage,
  };
}
