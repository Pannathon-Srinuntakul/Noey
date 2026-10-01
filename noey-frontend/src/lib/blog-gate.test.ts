import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blogGate, type BlogIndex } from "./blog-gate";
import { blogProxy, forgetBlogIndex, missingPath, resetBlogIndex } from "./blog-proxy";
import { navPathname } from "./nav-path";

/** 25 posts (3 listing pages of 12), a category with 13 (2 pages), an empty one, a tag with 1. */
const INDEX: BlogIndex = {
  slugs: new Set(["first-post", "second-post"]),
  categories: new Map([
    ["editing-tips", 13],
    ["news", 0],
  ]),
  tags: new Map([["capcut", 1]]),
  total: 25,
};

describe("blogGate (which blog URLs are a 404)", () => {
  it("passes every listing page that exists, and page 1 always (the empty state)", () => {
    expect(blogGate("/blog", null, INDEX)).toBe("pass");
    expect(blogGate("/blog", "3", INDEX)).toBe("pass");
    expect(blogGate("/blog", "1", { ...INDEX, total: 0 })).toBe("pass");
    expect(blogGate("/blog/", null, INDEX)).toBe("pass");
  });

  it("is missing past the last listing page", () => {
    expect(blogGate("/blog", "4", INDEX)).toBe("missing");
    expect(blogGate("/blog", "99", INDEX)).toBe("missing");
    expect(blogGate("/blog", "2", { ...INDEX, total: 0 })).toBe("missing");
  });

  it("leaves a malformed page number to the route (its own redirect/404 rules)", () => {
    expect(blogGate("/blog", "abc", INDEX)).toBe("pass");
  });

  it("checks categories: known (even empty) passes, unknown or past the last page is missing", () => {
    expect(blogGate("/blog/category/editing-tips", null, INDEX)).toBe("pass");
    expect(blogGate("/blog/category/editing-tips", "2", INDEX)).toBe("pass");
    expect(blogGate("/blog/category/editing-tips", "3", INDEX)).toBe("missing");
    expect(blogGate("/blog/category/news", null, INDEX)).toBe("pass");
    expect(blogGate("/blog/category/news", "2", INDEX)).toBe("missing");
    expect(blogGate("/blog/category/nope-xyz", null, INDEX)).toBe("missing");
  });

  it("checks tags the same way", () => {
    expect(blogGate("/blog/tag/capcut", null, INDEX)).toBe("pass");
    expect(blogGate("/blog/tag/capcut", "2", INDEX)).toBe("missing");
    expect(blogGate("/blog/tag/nope-xyz", null, INDEX)).toBe("missing");
  });

  it("checks post slugs", () => {
    expect(blogGate("/blog/first-post", null, INDEX)).toBe("pass");
    expect(blogGate("/blog/nope-xyz", null, INDEX)).toBe("missing");
  });

  it("calls the route segments that are no page on their own missing", () => {
    for (const path of ["/blog/page", "/blog/category", "/blog/tag", "/blog/md"]) expect(blogGate(path, null, INDEX)).toBe("missing");
  });

  it("leaves feeds, share images, .md twins and the internal paths to their own routes", () => {
    for (const path of [
      "/blog/feed.xml",
      "/blog/opengraph-image",
      "/blog/first-post/opengraph-image",
      "/blog/nope-xyz/opengraph-image",
      "/blog/first-post.md",
      "/blog/page/2",
      "/blog/md/first-post",
    ]) {
      expect(blogGate(path, null, INDEX)).toBe("pass");
    }
  });
});

describe("blogProxy (the index behind the gate)", () => {
  const API = "http://api.test";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const answers = (slugs: string[]) => (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/blog/slugs")) return Promise.resolve(json(slugs.map((slug) => ({ slug, updated_at: "2026-09-30T10:00:00Z" }))));
    if (url.endsWith("/blog/categories")) return Promise.resolve(json([{ slug: "editing-tips", name: "เทคนิคตัดต่อ", post_count: slugs.length }]));
    if (url.endsWith("/blog/tags")) return Promise.resolve(json([]));
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  /** An API that never answers (it only gives up when the caller aborts). */
  const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const rewriteOf = (response: Response) => response.headers.get("x-middleware-rewrite");
  const request = (path: string) => new NextRequest(new URL(path, "https://noeystudio.com"));
  const at = (seconds: number) => vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)));
  const timed = async (path: string) => {
    const start = performance.now();
    const response = await blogProxy(request(path), API);
    return { rewrite: rewriteOf(response), ms: performance.now() - start };
  };

  beforeEach(() => {
    resetBlogIndex();
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("answers 404 from a fresh index: a missing post, a page past the last, an unknown category", async () => {
    vi.stubGlobal("fetch", vi.fn(answers(["first-post"])));
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBe("https://noeystudio.com/blog/nope-xyz/__missing/404");
    expect(rewriteOf(await blogProxy(request("/blog?page=99"), API))).toBe("https://noeystudio.com/blog/__missing/404");
    expect(rewriteOf(await blogProxy(request("/blog/category/nope-xyz"), API))).toBe("https://noeystudio.com/blog/category/nope-xyz/__missing/404");
    expect(rewriteOf(await blogProxy(request("/blog/first-post"), API))).toBeNull();
  });

  it("never asks the API for a URL that cannot be missing (a feed, page 1 of the listing, a share image)", async () => {
    const fetchMock = vi.fn(hang);
    vi.stubGlobal("fetch", fetchMock);
    for (const path of ["/blog", "/blog/feed.xml", "/blog/first-post/opengraph-image", "/blog/first-post.md"]) {
      expect(rewriteOf(await blogProxy(request(path), API))).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up on a hanging API after about 500 ms and decides nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(hang));
    const { rewrite, ms } = await timed("/blog/nope-xyz");
    expect(rewrite).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(1500);
  });

  it("passes a URL through when the API fails: the page decides", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("busy", { status: 503 }))));
    at(20);
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBeNull();
  });

  it("backs off for 10 s after a failed reload: no retry storm, and no waiting meanwhile", async () => {
    const fetchMock = vi.fn(hang);
    vi.stubGlobal("fetch", fetchMock);
    await blogProxy(request("/blog/nope-a"), API);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    at(5);
    for (const path of ["/blog/nope-b", "/blog/nope-c", "/blog?page=40"]) {
      const { rewrite, ms } = await timed(path);
      expect(rewrite).toBeNull();
      expect(ms).toBeLessThan(50);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    at(11);
    fetchMock.mockImplementation(answers(["first-post"]));
    expect(rewriteOf(await blogProxy(request("/blog/nope-d"), API))).toContain("/__missing/404");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("never turns a URL away from a stale index while the API is down (a post published during the outage)", async () => {
    const fetchMock = vi.fn(answers(["first-post"]));
    vi.stubGlobal("fetch", fetchMock);
    await blogProxy(request("/blog/first-post"), API);
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));
    at(45);
    expect(rewriteOf(await blogProxy(request("/blog/published-during-outage"), API))).toBeNull();
    // A failed reload makes even a young index unfit to answer 404.
    at(46);
    expect(rewriteOf(await blogProxy(request("/blog/another-one"), API))).toBeNull();
  });

  it("serves a URL the index knows at once, even when the index is stale and the API hangs; it reloads in the background", async () => {
    const fetchMock = vi.fn(answers(["first-post"]));
    vi.stubGlobal("fetch", fetchMock);
    await blogProxy(request("/blog/first-post"), API);
    fetchMock.mockImplementation(hang);
    at(60);
    const { rewrite, ms } = await timed("/blog/first-post");
    expect(rewrite).toBeNull();
    expect(ms).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("checks a URL it does not know against a reload once the index is 2 s old", async () => {
    const fetchMock = vi.fn(answers(["first-post"]));
    vi.stubGlobal("fetch", fetchMock);
    await blogProxy(request("/blog/first-post"), API);
    fetchMock.mockImplementation(answers(["first-post", "just-published"]));
    at(5);
    expect(rewriteOf(await blogProxy(request("/blog/just-published"), API))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("lets a post published a moment ago through once the revalidation hook marks the index stale", async () => {
    const fetchMock = vi.fn(answers(["first-post"]));
    vi.stubGlobal("fetch", fetchMock);
    expect(rewriteOf(await blogProxy(request("/blog/new-post"), API))).toContain("/__missing/404");
    fetchMock.mockImplementation(answers(["first-post", "new-post"]));
    // Within the 2 s the index is young: without the hook it would still say missing.
    expect(rewriteOf(await blogProxy(request("/blog/new-post"), API))).toContain("/__missing/404");
    forgetBlogIndex();
    expect(rewriteOf(await blogProxy(request("/blog/new-post"), API))).toBeNull();
    expect(rewriteOf(await blogProxy(request("/blog/still-missing"), API))).toContain("/__missing/404");
  });

  it("checks a post the hook names again at once: one taken down gets the real 404 page", async () => {
    const fetchMock = vi.fn(answers(["first-post", "taken-down"]));
    vi.stubGlobal("fetch", fetchMock);
    expect(rewriteOf(await blogProxy(request("/blog/taken-down"), API))).toBeNull();
    fetchMock.mockImplementation(answers(["first-post"]));
    forgetBlogIndex(["taken-down"]);
    expect(rewriteOf(await blogProxy(request("/blog/taken-down"), API))).toContain("/__missing/404");
    // A post the hook did not name is still let through at once from the held index.
    fetchMock.mockImplementation(hang);
    forgetBlogIndex(["something-else"]);
    const { rewrite, ms } = await timed("/blog/first-post");
    expect(rewrite).toBeNull();
    expect(ms).toBeLessThan(50);
  });

  it("does not count a reload that started before the revalidation hook as fresh", async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/blog/slugs")) return new Promise<Response>((resolve) => (release = resolve));
      return answers(["first-post"])(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    const before = blogProxy(request("/blog/new-post"), API);
    forgetBlogIndex();
    release(json([{ slug: "first-post", updated_at: "2026-09-30T10:00:00Z" }]));
    expect(rewriteOf(await before)).toBeNull();
    fetchMock.mockImplementation(answers(["first-post", "new-post"]));
    expect(rewriteOf(await blogProxy(request("/blog/new-post"), API))).toBeNull();
  });

  it("stands aside for the development fixtures", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BLOG_FIXTURES", "1");
    const fetchMock = vi.fn(answers([]));
    vi.stubGlobal("fetch", fetchMock);
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("missingPath / navPathname", () => {
  it("keeps the path and adds a suffix no route matches", () => {
    expect(missingPath("/blog")).toBe("/blog/__missing/404");
    expect(missingPath("/blog/page")).toBe("/blog/page/__missing/404");
    expect(missingPath("/blog/category/nope-xyz/")).toBe("/blog/category/nope-xyz/__missing/404");
  });

  it("maps the listings' internal routes back to the address bar's", () => {
    expect(navPathname("/blog/page/1")).toBe("/blog");
    expect(navPathname("/blog/page/7")).toBe("/blog");
    expect(navPathname("/blog/category/editing-tips/page/2")).toBe("/blog/category/editing-tips");
    expect(navPathname("/blog/tag/capcut/page/1")).toBe("/blog/tag/capcut");
    expect(navPathname("/blog/some-post")).toBe("/blog/some-post");
    expect(navPathname("/guide/help")).toBe("/guide/help");
    expect(navPathname("/")).toBe("/");
  });
});
