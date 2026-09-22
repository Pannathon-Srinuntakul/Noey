import type { Metadata } from "next";
import { PlanComparisonTable } from "@/components/PlanComparisonTable";
import { GuideArticle } from "@/components/guide/GuideArticle";
import { GUIDE_DOCS } from "@/lib/guide";
import { markdownTwinPath, pageMetadata, withMarkdownTwin } from "@/lib/seo";
import { getPriceTable } from "@/lib/server/prices";

// The plan table is priced from the backend, like /pricing.
export const revalidate = 600;

export const metadata: Metadata = withMarkdownTwin(pageMetadata("guideHelp"), markdownTwinPath("guideHelp"));

export default async function HelpPage() {
  const table = await getPriceTable();
  return (
    <GuideArticle
      doc={GUIDE_DOCS.guideHelp}
      extras={{ "plan-limits": <PlanComparisonTable table={table} labelledBy="plan-limits-heading" /> }}
    />
  );
}
