import { buildLlmsTxt } from "@/lib/machine-readable";
import { getPriceTable } from "@/lib/server/prices";

// Same price source and refresh cadence as /pricing.
export const dynamic = "force-static";
export const revalidate = 600;

export async function GET() {
  const table = await getPriceTable();
  return new Response(buildLlmsTxt(table), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
