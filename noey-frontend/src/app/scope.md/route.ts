import { buildScopeMarkdown } from "@/lib/machine-readable";
import { markdownResponse } from "@/lib/markdown-response";

// Machine-readable twin of /scope, built from the same scope arrays.
export const dynamic = "force-static";
export const revalidate = 600;

export function GET() {
  return markdownResponse(buildScopeMarkdown(), "scope");
}
