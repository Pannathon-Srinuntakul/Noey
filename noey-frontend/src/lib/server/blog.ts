import "server-only";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import {
  BLOG_LIST_REVALIDATE,
  BLOG_PER_PAGE,
  BLOG_POST_REVALIDATE,
  isBlogSlug,
  mapCategories,
  mapListPage,
  mapPost,
  mapSlugs,
  mapTags,
  type BlogCategory,
  type BlogListPage,
  type BlogPost,
  type BlogSlug,
  type BlogTag,
} from "../blog";
import { blogMediaBase } from "../blog-media";
import { API_URL } from "./config";

/**
 * The blog's data layer: the public read API of BLOG_CONTRACT.md, fetched
 * with Next's data cache and tagged `blog` (every call) and `blog:<slug>`
 * (one post), so POST /api/revalidate-blog can expire exactly what changed.
 *
 * A call never throws: it answers `{ ok: false }` when the backend is down or
 * answers nonsense, and the PAGE decides what that means (`orUnavailable`):
 *  - during `next build` → render without the posts (a build never depends
 *    on the backend; on Railway the private API is unreachable while building);
 *  - on a production server → throw, so ISR keeps serving the last good page,
 *    and a page that was never rendered shows the blog's "try again" state
 *    (app/blog/error.tsx);
 *  - in development and tests → render without the posts, like the build.
 *
 * Fixtures (`BLOG_FIXTURES=1`, or `=empty` for the empty state) replace the
 * API in development and tests ONLY: the check is on NODE_ENV, which a
 * production build fixes to "production", so a production server can never
 * read them whatever its environment says (unit-tested).
 */

export type BlogResult<T> = { ok: true; data: T } | { ok: false };

const TIMEOUT_MS = 5_000;

export class BlogUnavailableError extends Error {
  constructor(what: string) {
    super(`blog API unavailable: ${what}`);
    this.name = "BlogUnavailableError";
  }
}

/** `BLOG_FIXTURES` is honoured outside production only. */
export function blogFixtureMode(): "posts" | "empty" | null {
  if (process.env.NODE_ENV === "production") return null;
  const flag = process.env.BLOG_FIXTURES?.trim();
  if (flag === "1") return "posts";
  if (flag === "empty") return "empty";
  return null;
}

function isBuilding(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

/**
 * What a page does with a failed call: throw on a production server (see the
 * module comment); anywhere else — the build, `next dev`, the unit tests —
 * `null`, and the page renders without the data (a listing then shows its
 * "could not load" state in place).
 */
export function orUnavailable<T>(result: BlogResult<T>, what: string): T | null {
  if (result.ok) return result.data;
  if (isBuilding() || process.env.NODE_ENV !== "production") {
    console.warn(`[blog] ${what}: the blog API did not answer; rendering without it`);
    return null;
  }
  throw new BlogUnavailableError(what);
}

type Fetched = { status: number; body: unknown };

async function getJson(path: string, revalidate: number, tags: string[]): Promise<Fetched> {
  // One retry for a network failure or a 5xx: a restart of the API must not
  // fail a build or a regeneration on its own.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${API_URL}${path}`, {
        headers: { Accept: "application/json" },
        next: { revalidate, tags },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status >= 500 && attempt === 0) continue;
      if (!response.ok) return { status: response.status, body: null };
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        return { status: 502, body: null };
      }
    } catch {
      if (attempt === 1) return { status: 0, body: null };
    }
  }
  return { status: 0, body: null };
}

async function fixtures() {
  // A literal NODE_ENV test: a production build folds it to `false` and drops
  // the import, so the fixture data is not even in the production bundle.
  if (process.env.NODE_ENV !== "production") {
    const { blogFixtureApi } = await import("./blog-fixtures");
    return blogFixtureApi(blogFixtureMode() === "empty");
  }
  throw new Error("blog fixtures are never used in production");
}

const mediaBase = () => blogMediaBase();

export interface ListQuery {
  page?: number;
  category?: string;
  tag?: string;
  perPage?: number;
}

function listQuery({ page = 1, category, tag, perPage = BLOG_PER_PAGE }: ListQuery): string {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (category) params.set("category", category);
  if (tag) params.set("tag", tag);
  return params.toString();
}

/** `GET /blog/posts` — one listing page, newest first. */
export async function getBlogPage(query: ListQuery = {}): Promise<BlogResult<BlogListPage>> {
  if ((query.category && !isBlogSlug(query.category)) || (query.tag && !isBlogSlug(query.tag))) {
    return { ok: true, data: { items: [], page: query.page ?? 1, perPage: query.perPage ?? BLOG_PER_PAGE, total: 0 } };
  }
  const { status, body } = blogFixtureMode()
    ? (await fixtures()).list(query)
    : await getJson(`/blog/posts?${listQuery(query)}`, BLOG_LIST_REVALIDATE, ["blog"]);
  const data = status === 200 ? mapListPage(body, mediaBase()) : null;
  return data ? { ok: true, data } : { ok: false };
}

/** `GET /blog/posts/{slug}` — `data: null` when the post is not published (404). */
export async function getBlogPost(slug: string): Promise<BlogResult<BlogPost | null>> {
  if (!isBlogSlug(slug)) return { ok: true, data: null };
  const { status, body } = blogFixtureMode()
    ? (await fixtures()).post(slug)
    : await getJson(`/blog/posts/${slug}`, BLOG_POST_REVALIDATE, ["blog", `blog:${slug}`]);
  if (status === 404) return { ok: true, data: null };
  if (status !== 200) return { ok: false };
  const post = mapPost(body, mediaBase());
  // A 200 whose body is not a usable post, or is another post: not this page's.
  if (!post) return { ok: false };
  return { ok: true, data: post.slug === slug ? post : null };
}

/** `GET /blog/slugs` — every published post (sitemap, static params). */
export async function getBlogSlugs(): Promise<BlogResult<BlogSlug[]>> {
  const { status, body } = blogFixtureMode() ? (await fixtures()).slugs() : await getJson("/blog/slugs", BLOG_LIST_REVALIDATE, ["blog"]);
  const data = status === 200 ? mapSlugs(body) : null;
  return data ? { ok: true, data } : { ok: false };
}

/** `GET /blog/categories` — the fixed categories with their published counts. */
export async function getBlogCategories(): Promise<BlogResult<BlogCategory[]>> {
  const { status, body } = blogFixtureMode()
    ? (await fixtures()).categories()
    : await getJson("/blog/categories", BLOG_LIST_REVALIDATE, ["blog"]);
  const data = status === 200 ? mapCategories(body) : null;
  return data ? { ok: true, data } : { ok: false };
}

/** `GET /blog/tags` — tags with at least one published post. */
export async function getBlogTags(): Promise<BlogResult<BlogTag[]>> {
  const { status, body } = blogFixtureMode() ? (await fixtures()).tags() : await getJson("/blog/tags", BLOG_LIST_REVALIDATE, ["blog"]);
  const data = status === 200 ? mapTags(body) : null;
  return data ? { ok: true, data } : { ok: false };
}

/**
 * The newest posts, for the files that list them (feeds, llms.txt, the
 * sitemap's listing pages). Same policy as the pages: `null` while building
 * when the API is down, a throw at run time.
 */
export async function latestPosts(limit: number, what: string) {
  const result = await getBlogPage({ page: 1, perPage: Math.min(50, limit) });
  return orUnavailable(result, what)?.items ?? null;
}
