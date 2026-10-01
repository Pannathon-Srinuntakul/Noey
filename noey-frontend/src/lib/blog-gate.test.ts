import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blogGate, type BlogIndex } from "./blog-gate";
import { blogProxy, forgetBlogIndex, missingPath } from "./blog-proxy";
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
  const rewriteOf = (response: Response) => response.headers.get("x-middleware-rewrite");
  const request = (path: string) => new NextRequest(new URL(path, "https://noeystudio.com"));

  beforeEach(() => {
    forgetBlogIndex();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rewrites a missing post to a path no route matches, and lets a published one through", async () => {
    vi.stubGlobal("fetch", vi.fn(answers(["first-post"])));
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBe("https://noeystudio.com/blog/nope-xyz/__missing/404");
    expect(rewriteOf(await blogProxy(request("/blog/first-post"), API))).toBeNull();
    expect(rewriteOf(await blogProxy(request("/blog?page=99"), API))).toBe("https://noeystudio.com/blog/__missing/404");
  });

  it("keeps the index for 30 s, but re-reads it before turning a URL away (a post published a moment ago)", async () => {
    const fetchMock = vi.fn(answers(["first-post"]));
    vi.stubGlobal("fetch", fetchMock);
    await blogProxy(request("/blog/first-post"), API);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await blogProxy(request("/blog/first-post"), API);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockImplementation(answers(["first-post", "just-published"]));
    vi.setSystemTime(new Date("2026-10-01T00:00:05Z"));
    expect(rewriteOf(await blogProxy(request("/blog/just-published"), API))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("decides nothing when the API does not answer: the page handles the outage", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    expect(rewriteOf(await blogProxy(request("/blog/nope-xyz"), API))).toBeNull();
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

describe("missingPath / navPathname (the header still knows the section on a rewritten 404)", () => {
  it("keeps the path and adds a suffix no route matches", () => {
    expect(missingPath("/blog")).toBe("/blog/__missing/404");
    expect(missingPath("/blog/page")).toBe("/blog/page/__missing/404");
    expect(missingPath("/blog/category/nope-xyz")).toBe("/blog/category/nope-xyz/__missing/404");
  });

  it("maps a rewritten path back to the address bar's", () => {
    for (const path of ["/blog", "/blog/nope-xyz", "/blog/page", "/blog/category/nope-xyz"]) expect(navPathname(missingPath(path))).toBe(path);
    expect(navPathname("/blog/page/1")).toBe("/blog");
    expect(navPathname("/blog/page/7")).toBe("/blog");
    expect(navPathname("/blog/category/editing-tips/page/2")).toBe("/blog/category/editing-tips");
    expect(navPathname("/blog/tag/capcut/page/1")).toBe("/blog/tag/capcut");
    expect(navPathname("/blog/some-post")).toBe("/blog/some-post");
    expect(navPathname("/guide/help")).toBe("/guide/help");
    expect(navPathname("/")).toBe("/");
  });
});
