import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { BLOG_FEED_PATH, BLOG_PATH, REVALIDATE_MAX_SLUGS, blogPostPath, parseRevalidateSlugs } from "@/lib/blog";

/**
 * POST /api/revalidate-blog — called by the backend after it publishes,
 * edits or takes down a post (BLOG_CONTRACT.md, "Revalidation"):
 * `Authorization: Bearer $BLOG_REVALIDATE_SECRET`, body `{ "slugs": [...] }`.
 *
 * Same shape as /api/revalidate-prices: unset secret = the route does not
 * exist (404); the secret is compared in constant time; it only marks
 * cached pages stale — it reads and writes nothing else.
 *
 * Expired at once (`expire: 0`), never served stale: a post the owner takes
 * down must be gone on the next visit. Listings are revalidated as a whole —
 * a post's old category or tags are not in the request, and every listing
 * page reads the tag `blog`. Paths are the routes' own files (the rewrite
 * DESTINATIONS, next.config.ts), as revalidatePath requires.
 */
const MAX_BODY_BYTES = 8 * 1024;

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const secret = process.env.BLOG_REVALIDATE_SECRET?.trim();
  if (!secret) return new NextResponse(null, { status: 404 });
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!secretMatches(given, secret)) return new NextResponse(null, { status: 401 });

  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const slugs = parseRevalidateSlugs(body);
  if (!slugs) return NextResponse.json({ error: "invalid_slugs", max: REVALIDATE_MAX_SLUGS }, { status: 400, headers: NO_STORE });

  // Every fetch the blog makes carries `blog`; a post's also `blog:<slug>`.
  revalidateTag("blog", { expire: 0 });
  for (const slug of slugs) {
    revalidateTag(`blog:${slug}`, { expire: 0 });
    revalidatePath(blogPostPath(slug));
    revalidatePath(`${BLOG_PATH}/md/${slug}`);
    revalidatePath(`${blogPostPath(slug)}/opengraph-image`);
  }
  // Listings: /blog (+ ?page=N), every category and tag page.
  revalidatePath(BLOG_PATH);
  revalidatePath(`${BLOG_PATH}/page/[page]`, "page");
  revalidatePath(`${BLOG_PATH}/category/[slug]/page/[page]`, "page");
  revalidatePath(`${BLOG_PATH}/tag/[slug]/page/[page]`, "page");
  for (const path of ["/sitemap.xml", "/feed.xml", BLOG_FEED_PATH, "/llms.txt"]) revalidatePath(path);

  return NextResponse.json({ revalidated: true, slugs }, { headers: NO_STORE });
}
