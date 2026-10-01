import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata as postMetadata } from "@/app/blog/[slug]/page";
import { generateMetadata as categoryMetadata } from "@/app/blog/category/[slug]/page/[page]/page";
import { generateMetadata as listingMetadata } from "@/app/blog/page/[page]/page";
import { generateMetadata as tagMetadata } from "@/app/blog/tag/[slug]/page/[page]/page";
import DATA from "./server/__fixtures__/blog.json";
import { forgetBlogAnswers } from "./server/blog";

/*
 * A blog URL that is a 404 must never carry a listing's or a post's
 * canonical, prev/next or `index`: generateMetadata answers the 404's own
 * metadata (and never throws), whatever the route.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const POST = DATA.posts[0];

function api(url: string): Response {
  const { pathname, searchParams } = new URL(url);
  if (pathname === "/blog/posts") {
    const page = Number(searchParams.get("page") ?? 1);
    return json({ items: page === 1 ? [POST] : [], page, per_page: 12, total: 13 });
  }
  if (pathname === "/blog/categories") return json([{ slug: "editing-tips", name: "เทคนิคตัดต่อ", description: "", post_count: 13 }]);
  if (pathname === "/blog/tags") return json([{ slug: "capcut", name: "CapCut", post_count: 13 }]);
  if (pathname === `/blog/posts/${POST.slug}`) return json(POST);
  return json({ detail: "not found" }, 404);
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

function expectMissing(metadata: Awaited<ReturnType<typeof listingMetadata>>) {
  expect(metadata.robots).toEqual({ index: false, follow: true });
  expect(metadata.alternates).toBeUndefined();
  expect(metadata.pagination).toBeUndefined();
  expect(metadata.title).toEqual({ absolute: "ไม่พบหน้าที่ต้องการ | Noey Studio" });
}

describe("blog 404 metadata", () => {
  beforeEach(() => {
    vi.stubEnv("BLOG_FIXTURES", "");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(api(String(input)))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    forgetBlogAnswers();
  });

  it("a listing page past the last one is noindex with no canonical", async () => {
    expectMissing(await listingMetadata(params({ page: "99" })));
    expectMissing(await listingMetadata(params({ page: "3" })));
    const last = await listingMetadata(params({ page: "2" }));
    expect(last.alternates?.canonical).toBe("https://noeystudio.com/blog?page=2");
  });

  it("the same for a category and a tag, and for one that does not exist", async () => {
    expectMissing(await categoryMetadata(params({ slug: "editing-tips", page: "99" })));
    expectMissing(await categoryMetadata(params({ slug: "nope-xyz", page: "1" })));
    expect((await categoryMetadata(params({ slug: "editing-tips", page: "2" }))).alternates?.canonical).toBe(
      "https://noeystudio.com/blog/category/editing-tips?page=2",
    );
    expectMissing(await tagMetadata(params({ slug: "capcut", page: "99" })));
    expectMissing(await tagMetadata(params({ slug: "nope-xyz", page: "1" })));
  });

  it("a post that is not published is noindex with no canonical; a published one keeps its own", async () => {
    expectMissing(await postMetadata(params({ slug: "nope-xyz" })));
    expect((await postMetadata(params({ slug: POST.slug }))).alternates?.canonical).toBe(`https://noeystudio.com/blog/${POST.slug}`);
  });
});
