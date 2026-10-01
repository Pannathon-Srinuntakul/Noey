/**
 * Which blog URLs are missing, decided BEFORE a page renders (src/proxy.ts).
 *
 * Why: a page that calls notFound() while it renders gets Next's error shell
 * — an empty HTML body, the 404 drawn by the browser, the root layout's
 * scripts re-created on the client — not the site's 404 page (measured on
 * this site, 2026-10-01; Next's own guidance for a 404 status is to check in
 * Proxy and rewrite to a not-found route). With the blog's published slugs,
 * categories and tags known here, a missing post or a page past the last one
 * is rewritten to a path no route matches, and the site's 404 page renders
 * on the server like any unknown URL. The pages keep their own notFound() as
 * the backstop. Pure (unit-tested); the fetching is in lib/blog-proxy.ts.
 */
import { BLOG_PER_PAGE, isBlogSlug, pageCount, parsePageParam } from "./blog";

export interface BlogIndex {
  slugs: ReadonlySet<string>;
  /** Category slug → published posts (every category exists, even with 0). */
  categories: ReadonlyMap<string, number>;
  /** Tag slug → published posts (only tags that have one). */
  tags: ReadonlyMap<string, number>;
  total: number;
}

/** Path segments under /blog that are routes, not post slugs. */
const NOT_POSTS = new Set(["page", "category", "tag", "md", "opengraph-image"]);
/** …and of those, the ones that are no page on their own (/blog/category). */
const NOT_PAGES = new Set(["page", "category", "tag", "md"]);

/** A page past the last one (page 1 always exists: it is the empty state). */
function pastLast(page: string | null, posts: number): boolean {
  const n = parsePageParam(page ?? undefined);
  return n !== null && n > 1 && n > pageCount(posts, BLOG_PER_PAGE);
}

/** "missing" when the URL names a post, category, tag or page that does not exist; otherwise "pass". */
export function blogGate(pathname: string, page: string | null, index: BlogIndex): "pass" | "missing" {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(2);
  if (parts.length === 0) return pastLast(page, index.total) ? "missing" : "pass";
  const [first, second] = parts;
  if ((first === "category" || first === "tag") && parts.length === 2 && isBlogSlug(second)) {
    const count = (first === "category" ? index.categories : index.tags).get(second);
    if (count === undefined) return "missing";
    return pastLast(page, count) ? "missing" : "pass";
  }
  if (parts.length === 1 && NOT_PAGES.has(first)) return "missing";
  if (parts.length === 1 && isBlogSlug(first) && !NOT_POSTS.has(first)) return index.slugs.has(first) ? "pass" : "missing";
  // Everything else (feeds, share images, .md twins, the internal listing
  // paths that redirect) is left to its own route.
  return "pass";
}
