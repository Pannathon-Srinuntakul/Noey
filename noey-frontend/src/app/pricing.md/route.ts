import { buildPricingMarkdown } from "@/lib/machine-readable";
import { getPriceTable } from "@/lib/server/prices";
import { PAGES, absoluteUrl } from "@/lib/site";

// Machine-readable twin of /pricing: same PriceTable, same cadence.
export const dynamic = "force-static";
export const revalidate = 600;

export async function GET() {
  const table = await getPriceTable();
  return new Response(buildPricingMarkdown(table, PAGES.pricing.updated), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // Crawlable for agents, but the HTML page is the canonical document.
      Link: `<${absoluteUrl(PAGES.pricing.path)}>; rel="canonical"`,
    },
  });
}
