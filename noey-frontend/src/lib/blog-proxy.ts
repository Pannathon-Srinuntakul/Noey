/**
 * The blog half of src/proxy.ts: answer a missing post, category, tag or
 * listing page with the site's real 404 page (see lib/blog-gate.ts for why).
 *
 * The index of what is published comes from three small public calls
 * (/blog/slugs, /blog/categories, /blog/tags). The rules, in order:
 *
 * - A URL that can never be missing (a feed, a share image, page 1 of the
 *   listing) and a URL the held index already knows are let through at
 *   once, never waiting on the API. An index past its 30 s is reloaded in
 *   the background.
 * - Only a URL the index does not know waits for a reload, at most 500 ms.
 *   A reload that fails or times out is not tried again for 10 s.
 * - Proxy answers 404 only from an index fetched successfully within the
 *   last 30 s, with no failed reload since. Otherwise (the API slow or down,
 *   no index yet) it decides nothing: the page renders and keeps its own
 *   notFound() as the backstop.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mapCategories, mapSlugs, mapTags } from "./blog";
import { blogGate, type BlogIndex } from "./blog-gate";

/** How long a successful index may turn URLs away. */
const FRESH_MS = 30_000;
/** A URL the index does not know is checked against a reload when the index is older than this. */
const RECHECK_MS = 2_000;
/** One reload, all three calls together. */
const TIMEOUT_MS = 500;
/** After a failed reload, no new attempt for this long. */
const BACKOFF_MS = 10_000;

/** A path no route matches: Next renders the site's 404 page (app/not-found.tsx) for it, on the server. */
const MISSING_SUFFIX = "/__missing/404";

/**
 * Where a missing blog URL is rewritten: the same path plus a suffix no
 * route matches, so Next renders the site's 404 page for it on the server,
 * as for any unknown URL.
 */
export function missingPath(pathname: string): string {
  return `${pathname.replace(/\/+$/, "")}${MISSING_SUFFIX}`;
}

/** An index that knows nothing: a URL it lets through can never be missing. */
const EMPTY: BlogIndex = { slugs: new Set(), categories: new Map(), tags: new Map(), total: 0 };

/*
 * Kept on globalThis: Proxy and the revalidation route are bundled
 * separately but run in one server process, and the route must be able to
 * mark the index stale when the backend publishes or takes a post down.
 */
interface IndexState {
  /** The last index fetched successfully, and when. */
  index: BlogIndex | null;
  at: number;
  /** When the last reload failed (0: none since the last success). */
  failedAt: number;
  loading: Promise<BlogIndex | null> | null;
  /** Bumped by forgetBlogIndex: a reload that started before it does not count as fresh. */
  generation: number;
}
const STATE_KEY = Symbol.for("noey.blog-index");
const state: IndexState = ((globalThis as Record<symbol, IndexState | undefined>)[STATE_KEY] ??= {
  index: null,
  at: 0,
  failedAt: 0,
  loading: null,
  generation: 0,
});

/** The held index may turn a URL away: fetched within the window, no failed reload since. */
function isFresh(now: number): boolean {
  return state.index !== null && now - state.at < FRESH_MS && state.failedAt <= state.at;
}

function inBackoff(now: number): boolean {
  return state.failedAt > state.at && now - state.failedAt < BACKOFF_MS;
}

async function getJson(api: string, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${api}${path}`, { headers: { Accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

async function load(api: string): Promise<BlogIndex | null> {
  const generation = state.generation;
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const [slugs, categories, tags] = await Promise.all([
      getJson(api, "/blog/slugs", signal),
      getJson(api, "/blog/categories", signal),
      getJson(api, "/blog/tags", signal),
    ]);
    const s = mapSlugs(slugs);
    const c = mapCategories(categories);
    const t = mapTags(tags);
    if (!s || !c || !t) throw new Error("index answer not understood");
    const index: BlogIndex = {
      slugs: new Set(s.map((item) => item.slug)),
      categories: new Map(c.map((item) => [item.slug, item.postCount])),
      tags: new Map(t.map((item) => [item.slug, item.postCount])),
      total: s.length,
    };
    // An answer asked for before the backend's last change is not kept.
    if (generation !== state.generation) return null;
    state.index = index;
    state.at = Date.now();
    state.failedAt = 0;
    return index;
  } catch {
    if (generation === state.generation) state.failedAt = Date.now();
    return null;
  }
}

/** One reload at a time; none while backing off. Resolves to null when there is no new index. */
function reload(api: string): Promise<BlogIndex | null> {
  if (state.loading) return state.loading;
  if (inBackoff(Date.now())) return Promise.resolve(null);
  const loading: Promise<BlogIndex | null> = load(api).finally(() => {
    if (state.loading === loading) state.loading = null;
  });
  state.loading = loading;
  return loading;
}

/**
 * Mark the index stale (POST /api/revalidate-blog): a URL it does not know
 * is checked against a reload before it can be turned away, and a URL it
 * knows is still let through at once while the reload runs. The posts the
 * backend just changed are dropped from it, so they are checked against
 * the reload too: a post taken down gets the real 404 page at once.
 */
export function forgetBlogIndex(changed: readonly string[] = []): void {
  if (state.index && changed.length) {
    const slugs = new Set(state.index.slugs);
    for (const slug of changed) slugs.delete(slug);
    state.index = { ...state.index, slugs };
  }
  state.at = 0;
  state.failedAt = 0;
  state.generation += 1;
  state.loading = null;
}

/** Drop everything, including what a reload still in flight would bring (tests). */
export function resetBlogIndex(): void {
  state.index = null;
  state.at = 0;
  state.failedAt = 0;
  state.loading = null;
  state.generation += 1;
}

export async function blogProxy(request: NextRequest, api: string): Promise<NextResponse> {
  // Development fixtures stand in for the API in the pages only.
  if (process.env.NODE_ENV !== "production" && process.env.BLOG_FIXTURES) return NextResponse.next();
  const { pathname, searchParams } = request.nextUrl;
  const page = searchParams.get("page");
  // Never missing whatever is published: not held up at all.
  if (blogGate(pathname, page, EMPTY) === "pass") return NextResponse.next();

  const now = Date.now();
  if (state.index && blogGate(pathname, page, state.index) === "pass") {
    if (!isFresh(now)) void reload(api);
    return NextResponse.next();
  }

  // Not a URL the held index knows: ask again (≤ 500 ms) unless the index is
  // fresh and young, or the last attempt failed moments ago.
  if (!isFresh(now) || now - state.at >= RECHECK_MS) {
    if (!(await reload(api))) return NextResponse.next();
  }
  if (!state.index || !isFresh(Date.now())) return NextResponse.next();
  return blogGate(pathname, page, state.index) === "missing" ? NextResponse.rewrite(new URL(missingPath(pathname), request.url)) : NextResponse.next();
}
