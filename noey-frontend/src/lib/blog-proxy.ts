/**
 * The blog half of src/proxy.ts: answer a missing post, category, tag or
 * listing page with the site's real 404 page (see lib/blog-gate.ts for why).
 *
 * The index of what is published comes from three small public calls
 * (/blog/slugs, /blog/categories, /blog/tags), kept in this process for 30 s
 * and dropped at once by the revalidation hook. A URL that looks missing
 * against an index older than 2 s re-reads it first, so a post published a
 * moment ago is never turned away. When the API does not answer, nothing is
 * decided here: the page handles it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mapCategories, mapSlugs, mapTags } from "./blog";
import { blogGate, type BlogIndex } from "./blog-gate";
import { MISSING_SUFFIX } from "./nav-path";

const FRESH_MS = 30_000;
const RECHECK_MS = 2_000;

/**
 * Where a missing blog URL is rewritten: the same path plus a suffix no
 * route matches, so Next renders the site's 404 page (app/not-found.tsx) for
 * it on the server, as for any unknown URL. The path is kept so the header
 * can still tell which section the visitor was in (lib/nav-path.ts).
 */
export function missingPath(pathname: string): string {
  return `${pathname.replace(/\/+$/, "")}${MISSING_SUFFIX}`;
}

/*
 * Kept on globalThis: Proxy and the revalidation route are bundled
 * separately but run in one server process, and the route must be able to
 * drop the index when the backend publishes or takes a post down.
 */
interface IndexState {
  cached: { at: number; index: BlogIndex } | null;
  loading: Promise<BlogIndex | null> | null;
}
const STATE_KEY = Symbol.for("noey.blog-index");
const state: IndexState = ((globalThis as Record<symbol, IndexState | undefined>)[STATE_KEY] ??= { cached: null, loading: null });

async function getJson(api: string, path: string): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

async function load(api: string): Promise<BlogIndex | null> {
  try {
    const [slugs, categories, tags] = await Promise.all([getJson(api, "/blog/slugs"), getJson(api, "/blog/categories"), getJson(api, "/blog/tags")]);
    const s = mapSlugs(slugs);
    const c = mapCategories(categories);
    const t = mapTags(tags);
    if (!s || !c || !t) return null;
    const index: BlogIndex = {
      slugs: new Set(s.map((item) => item.slug)),
      categories: new Map(c.map((item) => [item.slug, item.postCount])),
      tags: new Map(t.map((item) => [item.slug, item.postCount])),
      total: s.length,
    };
    state.cached = { at: Date.now(), index };
    return index;
  } catch {
    return null;
  }
}

async function blogIndex(api: string, maxAge: number): Promise<BlogIndex | null> {
  if (state.cached && Date.now() - state.cached.at < maxAge) return state.cached.index;
  state.loading ??= load(api).finally(() => {
    state.loading = null;
  });
  return (await state.loading) ?? state.cached?.index ?? null;
}

/** Forget the index: the next blog request reads it again (POST /api/revalidate-blog, tests). */
export function forgetBlogIndex(): void {
  state.cached = null;
}

export async function blogProxy(request: NextRequest, api: string): Promise<NextResponse> {
  // Development fixtures stand in for the API in the pages only.
  if (process.env.NODE_ENV !== "production" && process.env.BLOG_FIXTURES) return NextResponse.next();
  const { pathname, searchParams } = request.nextUrl;
  const page = searchParams.get("page");
  let index = await blogIndex(api, FRESH_MS);
  if (!index) return NextResponse.next();
  let gate = blogGate(pathname, page, index);
  if (gate === "missing" && state.cached && Date.now() - state.cached.at >= RECHECK_MS) {
    index = await blogIndex(api, 0);
    if (!index) return NextResponse.next();
    gate = blogGate(pathname, page, index);
  }
  return gate === "missing" ? NextResponse.rewrite(new URL(missingPath(pathname), request.url)) : NextResponse.next();
}
