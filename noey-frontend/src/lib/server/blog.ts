import "server-only";
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
import { blogEmbedOrigin, blogMediaBase } from "../blog-media";
import { API_URL } from "./config";

/**
 * The blog's data layer: the public read API of BLOG_CONTRACT.md, fetched
 * with Next's data cache and tagged `blog` (every call) and `blog:<slug>`
 * (one post), so POST /api/revalidate-blog can expire exactly what changed.
 *
 * When the backend is down (no answer, a 5xx, or nonsense):
 *  1. the call is retried once — a restart of the API must not fail a build
 *     or a regeneration on its own;
 *  2. the last good answer this server saw for the same request is used, so
 *     a page regenerated during the outage keeps the content it had;
 *  3. otherwise the call answers `{ ok: false }` and the page renders its
 *     "could not load" state in place (`orUnavailable` → null). Never a
 *     throw: Next answers a failed first render of an ISR page with a bare
 *     "Internal Server Error" (measured, 2026-10-01), and never a 404 — the
 *     post may well exist.
 * Either way the retry was made with a 30-second lifetime, which Next takes
 * as the page's own: the page is tried again 30 s later instead of keeping
 * the stand-in for its usual 10 minutes. A build that cannot reach the API
 * (Railway builds without the private network) is the same case.
 *
 * Fixtures (`BLOG_FIXTURES=1`, or `=empty` for the empty state) replace the
 * API in development and tests ONLY: the check is on NODE_ENV, which a
 * production build fixes to "production", so a production server can never
 * read them whatever its environment says (unit-tested).
 */

export type BlogResult<T> = { ok: true; data: T } | { ok: false };

const TIMEOUT_MS = 5_000;
/** Seconds a page rendered without (fresh) data is kept before it is tried again. */
export const BLOG_RETRY_REVALIDATE = 30;

/** `BLOG_FIXTURES` is honoured outside production only. */
export function blogFixtureMode(): "posts" | "empty" | null {
  if (process.env.NODE_ENV === "production") return null;
  const flag = process.env.BLOG_FIXTURES?.trim();
  if (flag === "1") return "posts";
  if (flag === "empty") return "empty";
  return null;
}

/** The data, or null (logged) when the API did not answer: the page renders its "could not load" state. */
export function orUnavailable<T>(result: BlogResult<T>, what: string): T | null {
  if (result.ok) return result.data;
  console.warn(`[blog] ${what}: the blog API did not answer; rendering without it`);
  return null;
}

type Fetched = { status: number; body: unknown };

/** The last good JSON body per request path, for an outage (bounded; this process only). */
const lastGood = new Map<string, unknown>();
const LAST_GOOD_MAX = 300;

function remember(path: string, body: unknown) {
  lastGood.delete(path);
  lastGood.set(path, body);
  if (lastGood.size > LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value as string);
}

/** Forget every remembered answer (tests). */
export function forgetBlogAnswers(): void {
  lastGood.clear();
}

async function attempt(path: string, revalidate: number, tags: string[]): Promise<Fetched> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { Accept: "application/json" },
      next: { revalidate, tags },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { status: response.status, body: null };
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      return { status: 502, body: null };
    }
  } catch {
    return { status: 0, body: null };
  }
}

const isOutage = (status: number) => status === 0 || status >= 500;

async function getJson(path: string, revalidate: number, tags: string[]): Promise<Fetched> {
  let answer = await attempt(path, revalidate, tags);
  // The retry carries the short lifetime: the page that used it is tried again soon.
  if (isOutage(answer.status)) answer = await attempt(path, BLOG_RETRY_REVALIDATE, tags);
  if (answer.status === 200) remember(path, answer.body);
  else if (isOutage(answer.status) && lastGood.has(path)) return { status: 200, body: lastGood.get(path) };
  return answer;
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
  const post = mapPost(body, mediaBase(), blogEmbedOrigin());
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
