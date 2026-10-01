import { BLOG_FEED_LIMIT } from "@/lib/blog";
import { buildAtomFeed } from "@/lib/feed";
import { latestPosts } from "@/lib/server/blog";

// Static like the rest of the marketing site; the dates come from the page
// registry and from the blog posts themselves, not from build time. Blog
// posts join with their own dates (tag `blog`, revalidated on publish).
export const dynamic = "force-static";
export const revalidate = 600;

export async function GET() {
  const posts = (await latestPosts(BLOG_FEED_LIMIT, "site feed")) ?? [];
  return new Response(buildAtomFeed(posts), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
  });
}
