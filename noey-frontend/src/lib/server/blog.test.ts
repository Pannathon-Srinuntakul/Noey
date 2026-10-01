import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapPost } from "../blog";
import DATA from "./__fixtures__/blog.json";
import {
  BLOG_RETRY_REVALIDATE,
  blogFixtureMode,
  forgetBlogAnswers,
  getBlogCategories,
  getBlogPage,
  getBlogPost,
  getBlogSlugs,
  getBlogTags,
  orUnavailable,
} from "./blog";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const POST = DATA.posts[0];

describe("blog data layer (the API)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BLOG_FIXTURES", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
    forgetBlogAnswers();
  });

  it("asks GET /blog/posts with the listing's query, tags the fetch `blog`, maps the answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [POST], page: 2, per_page: 12, total: 13 }));
    const result = await getBlogPage({ page: 2, category: "editing-tips" });
    expect(result.ok && result.data.items[0].slug).toBe(POST.slug);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9/blog/posts?page=2&per_page=12&category=editing-tips");
    expect(init.next).toEqual({ revalidate: 600, tags: ["blog"] });
  });

  it("tags one post `blog` and `blog:<slug>`, and reads a 404 as not published", async () => {
    fetchMock.mockResolvedValueOnce(json(POST)).mockResolvedValueOnce(json({ detail: "not found" }, 404));
    const found = await getBlogPost(POST.slug);
    expect(found.ok && found.data?.title).toBe(POST.title);
    expect(fetchMock.mock.calls[0][1].next).toEqual({ revalidate: 3600, tags: ["blog", `blog:${POST.slug}`] });
    expect(await getBlogPost("missing-post")).toEqual({ ok: true, data: null });
  });

  it("never sends an invalid slug to the API", async () => {
    expect(await getBlogPost("../admin")).toEqual({ ok: true, data: null });
    expect(await getBlogPage({ category: "Bad Slug" })).toMatchObject({ ok: true, data: { items: [], total: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers `ok: false` — never throws — when the API is down, errors or talks nonsense", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await getBlogPage()).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ detail: "boom" }, 503));
    expect(await getBlogSlugs()).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    expect(await getBlogCategories()).toEqual({ ok: false });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ unexpected: true }));
    expect(await getBlogTags()).toEqual({ ok: false });
    expect(await getBlogPost(POST.slug)).toEqual({ ok: false });
  });

  it("retries an outage once, with the short lifetime the page then takes on", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502)).mockResolvedValueOnce(json([{ slug: "a", updated_at: "2026-10-01T00:00:00Z" }]));
    expect(await getBlogSlugs()).toEqual({ ok: true, data: [{ slug: "a", updatedAt: "2026-10-01T00:00:00.000Z" }] });
    expect(fetchMock.mock.calls[0][1].next.revalidate).toBe(600);
    expect(fetchMock.mock.calls[1][1].next.revalidate).toBe(BLOG_RETRY_REVALIDATE);
  });

  it("keeps showing the last good answer through an outage, but not past a real 404", async () => {
    fetchMock.mockResolvedValueOnce(json(POST));
    expect((await getBlogPost(POST.slug)).ok).toBe(true);
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const during = await getBlogPost(POST.slug);
    expect(during.ok && during.data?.title).toBe(POST.title);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ detail: "not found" }, 404));
    expect(await getBlogPost(POST.slug)).toEqual({ ok: true, data: null });
  });

  it("does not take another post's body for this page", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...POST, slug: "someone-else" }));
    expect(await getBlogPost(POST.slug)).toEqual({ ok: true, data: null });
  });
});

describe("what a page does when the API is down", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders its own 'could not load' state — never a throw, on a production server too", () => {
    for (const phase of ["phase-production-server", "phase-production-build"]) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", phase);
      expect(orUnavailable({ ok: false }, "test")).toBeNull();
    }
  });

  it("passes data through", () => {
    expect(orUnavailable({ ok: true, data: [1] }, "test")).toEqual([1]);
  });
});

describe("fixtures (BLOG_FIXTURES)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("are five posts in the contract's exact shape: a cover, no cover, no FAQ, a long title", () => {
    expect(DATA.posts).toHaveLength(5);
    const posts = DATA.posts.map((post) => mapPost(post, "https://api.noeystudio.com/blog/media"));
    expect(posts.every(Boolean)).toBe(true);
    expect(posts.some((post) => post?.cover)).toBe(true);
    expect(posts.some((post) => !post?.cover)).toBe(true);
    expect(posts.some((post) => post?.faq.length === 0)).toBe(true);
    expect(posts.some((post) => (post?.title.length ?? 0) > 100)).toBe(true);
    for (const post of DATA.posts) {
      expect(Object.keys(post).sort()).toEqual(
        [
          "author", "category", "content_md", "cover_alt", "cover_height", "cover_image_url", "cover_width", "excerpt", "faq",
          "meta_description", "meta_title", "published_at", "reading_minutes", "slug", "source", "tags", "title", "updated_at",
        ].sort(),
      );
      expect(post.meta_title.length).toBeLessThanOrEqual(60);
      expect(post.meta_description.length).toBeLessThanOrEqual(160);
      expect(post.excerpt.length).toBeLessThanOrEqual(300);
      expect(post.content_md).not.toMatch(/^# /m);
    }
  });

  it("answer instead of the API in development and tests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BLOG_FIXTURES", "1");
    expect(blogFixtureMode()).toBe("posts");
    const page = await getBlogPage();
    expect(page.ok && page.data.total).toBe(5);
    const post = await getBlogPost(POST.slug);
    expect(post.ok && post.data?.related.length).toBeGreaterThan(0);
    vi.stubEnv("BLOG_FIXTURES", "empty");
    expect(await getBlogPage()).toMatchObject({ ok: true, data: { items: [], total: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("are never used by a production server, whatever BLOG_FIXTURES says", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BLOG_FIXTURES", "1");
    expect(blogFixtureMode()).toBeNull();
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [], page: 1, per_page: 12, total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const page = await getBlogPage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.ok && page.data.total).toBe(0);
  });
});
