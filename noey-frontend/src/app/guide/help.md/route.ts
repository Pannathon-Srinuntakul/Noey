import { GUIDE_DOCS } from "@/lib/guide";
import { buildGuideMarkdown } from "@/lib/machine-readable";
import { markdownResponse } from "@/lib/markdown-response";

// Machine-readable twin of the HTML guide page, built from the same content.
export const dynamic = "force-static";
export const revalidate = 600;

export function GET() {
  return markdownResponse(buildGuideMarkdown(GUIDE_DOCS.guideHelp), "guideHelp");
}
