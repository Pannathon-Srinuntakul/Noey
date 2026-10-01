import { BLOG_LLMS_LIMIT } from "@/lib/blog";
import { buildLlmsTxt } from "@/lib/machine-readable";
import { latestPosts } from "@/lib/server/blog";
import { getPriceTable } from "@/lib/server/prices";

// Same price source and refresh cadence as /pricing; the newest blog posts
// with the listings' (tag `blog`, revalidated on publish).
export const dynamic = "force-static";
export const revalidate = 600;

export async function GET() {
  const [table, posts] = await Promise.all([getPriceTable(), latestPosts(BLOG_LLMS_LIMIT, "llms.txt")]);
  return new Response(buildLlmsTxt(table, posts ?? []), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
