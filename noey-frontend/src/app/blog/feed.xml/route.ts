import { BLOG_FEED_LIMIT } from "@/lib/blog";
import { buildBlogFeed } from "@/lib/blog-machine";
import { latestPosts } from "@/lib/server/blog";

// Static like the listings, refreshed with them (tag `blog`). While a build
// cannot reach the API the feed is built empty and ISR fills it in.
export const dynamic = "force-static";
export const revalidate = 600;

export async function GET() {
  const posts = (await latestPosts(BLOG_FEED_LIMIT, "blog feed")) ?? [];
  return new Response(buildBlogFeed(posts), {
    headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
  });
}
