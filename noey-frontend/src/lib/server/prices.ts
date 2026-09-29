import "server-only";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { fallbackPriceTable, isBetaPriced, normalizePlansResponse, type PriceTable } from "../plans";
import { API_URL } from "./config";

/** Seconds between price refreshes; matches `revalidate` on the pages that show prices. */
export const PRICES_REVALIDATE_SECONDS = 600;

/**
 * Prices for every surface that shows them (home, /pricing, JSON-LD offers,
 * /pricing.md, /llms.txt, the upgrade dialog).
 *
 * When `GET /billing/plans` fails:
 *  - during `next build` (and in dev) -> the design's mock prices, so a build
 *    never depends on the backend being up;
 *  - at production runtime on an ISR page -> throw, so Next.js keeps serving
 *    the last good page instead of replacing real prices with mock ones;
 *  - `fallbackOnError` (dynamic pages such as /account/billing) -> mock prices.
 */
export async function getPriceTable(options: { fallbackOnError?: boolean } = {}): Promise<PriceTable> {
  try {
    const response = await fetch(`${API_URL}/billing/plans`, {
      headers: { Accept: "application/json" },
      next: { revalidate: PRICES_REVALIDATE_SECONDS, tags: ["billing-plans"] },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`GET /billing/plans answered ${response.status}`);
    const table = normalizePlansResponse(await response.json());
    if (!table) throw new Error("GET /billing/plans returned an unexpected body");
    return table;
  } catch (error) {
    const building = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
    if (building || options.fallbackOnError || process.env.NODE_ENV !== "production") {
      console.warn(`[prices] using design fallback prices: ${(error as Error).message}`);
      return fallbackPriceTable();
    }
    throw error;
  }
}

/**
 * Is the beta discount real right now? Only an answer from the backend counts:
 * the design fallback carries the beta ladder by construction (it is what the
 * build uses when the API is unreachable), so treating it as evidence would
 * bake a discount claim into static pages that the live catalog does not make.
 * Any failure reads as "no" — a missing claim is harmless, a false one is not.
 */
export async function catalogIsBetaPriced(): Promise<boolean> {
  try {
    const table = await getPriceTable();
    return table.source !== "fallback" && isBetaPriced(table);
  } catch {
    return false;
  }
}
