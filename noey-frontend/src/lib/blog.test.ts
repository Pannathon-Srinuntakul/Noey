import { describe, expect, it } from "vitest";
import {
  allowedImageUrl,
  isBlogSlug,
  isUnderMediaBase,
  mapCategories,
  mapListPage,
  mapPost,
  mapPostSummary,
  mapSlugs,
  mapTags,
  pageCount,
  parsePageParam,
  parseRevalidateSlugs,
  wasUpdated,
  withPage,
} from "./blog";
import { blogMediaBase, blogMediaCspOrigin, blogMediaRemotePattern } from "./blog-media";
import { staticContentSecurityPolicy } from "./csp";

const MEDIA = "https://api.noeystudio.com/blog/media";
const COVER = `${MEDIA}/${"a".repeat(64)}.webp`;

/** A post exactly as BLOG_CONTRACT.md says the API returns it. */
function apiPost(overrides: Record<string, unknown> = {}) {
  return {
    slug: "thai-subtitles-tiktok-tips",
    title: "ซับไทยในคลิปสั้น",
    meta_title: "ซับไทยในคลิปสั้น | Noey Studio",
    meta_description: "คำอธิบายสำหรับเครื่องมือค้นหา",
    excerpt: "สรุปสั้น ๆ ของบทความ",
    content_md: "ย่อหน้าแรก\n\n## หัวข้อ\n\nเนื้อหา",
    cover_image_url: COVER,
    cover_alt: "ภาพปก",
    cover_width: 1600,
    cover_height: 900,
    category: { slug: "editing-tips", name: "เทคนิคตัดต่อ" },
    tags: [{ slug: "subtitles", name: "ซับไทย" }],
    faq: [{ question: "คำถาม", answer: "คำตอบ" }],
    author: "Noey Studio",
    source: "ai",
    reading_minutes: 6,
    published_at: "2026-09-30T02:00:00Z",
    updated_at: "2026-10-01T04:30:00Z",
    related: [
      {
        slug: "other-post",
        title: "บทความอื่น",
        excerpt: "สรุป",
        cover_image_url: null,
        cover_alt: null,
        category: { slug: "editing-tips", name: "เทคนิคตัดต่อ" },
        published_at: "2026-09-20T01:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("blog API mapping", () => {
  it("maps every contract field to the page's view of a post", () => {
    const post = mapPost(apiPost(), MEDIA)!;
    expect(post).toMatchObject({
      slug: "thai-subtitles-tiktok-tips",
      title: "ซับไทยในคลิปสั้น",
      metaTitle: "ซับไทยในคลิปสั้น | Noey Studio",
      metaDescription: "คำอธิบายสำหรับเครื่องมือค้นหา",
      excerpt: "สรุปสั้น ๆ ของบทความ",
      cover: { url: COVER, alt: "ภาพปก", width: 1600, height: 900 },
      category: { slug: "editing-tips", name: "เทคนิคตัดต่อ" },
      tags: [{ slug: "subtitles", name: "ซับไทย" }],
      faq: [{ question: "คำถาม", answer: "คำตอบ" }],
      source: "ai",
      readingMinutes: 6,
      publishedAt: "2026-09-30T02:00:00.000Z",
      updatedAt: "2026-10-01T04:30:00.000Z",
    });
    expect(post.contentMd).toContain("## หัวข้อ");
    expect(post.related).toEqual([
      {
        slug: "other-post",
        title: "บทความอื่น",
        excerpt: "สรุป",
        cover: null,
        category: { slug: "editing-tips", name: "เทคนิคตัดต่อ" },
        publishedAt: "2026-09-20T01:00:00.000Z",
      },
    ]);
  });

  it("drops a post it cannot render safely instead of rendering it half-broken", () => {
    expect(mapPostSummary(apiPost({ slug: "Bad Slug" }), MEDIA)).toBeNull();
    expect(mapPostSummary(apiPost({ slug: "../etc" }), MEDIA)).toBeNull();
    expect(mapPostSummary(apiPost({ slug: "a".repeat(81) }), MEDIA)).toBeNull();
    expect(mapPostSummary(apiPost({ title: "  " }), MEDIA)).toBeNull();
    expect(mapPostSummary(apiPost({ category: null }), MEDIA)).toBeNull();
    expect(mapPostSummary(apiPost({ published_at: "yesterday" }), MEDIA)).toBeNull();
    expect(mapPost(apiPost({ content_md: "" }), MEDIA)).toBeNull();
    expect(mapPostSummary("not an object", MEDIA)).toBeNull();
  });

  it("keeps only a cover the page may load, with a sane size", () => {
    expect(mapPost(apiPost({ cover_image_url: "javascript:alert(1)" }), MEDIA)!.cover).toBeNull();
    expect(mapPost(apiPost({ cover_image_url: "http://evil.example/x.webp" }), MEDIA)!.cover).toBeNull();
    expect(mapPost(apiPost({ cover_image_url: "https://other.example/x.webp" }), MEDIA)!.cover?.url).toBe("https://other.example/x.webp");
    expect(mapPost(apiPost({ cover_image_url: null }), MEDIA)!.cover).toBeNull();
    const local = "http://localhost:8010/blog/media/x.webp";
    expect(mapPost(apiPost({ cover_image_url: local }), "http://localhost:8010/blog/media")!.cover?.url).toBe(local);
    expect(mapPost(apiPost({ cover_width: -5, cover_height: 1.5 }), MEDIA)!.cover).toMatchObject({ width: null, height: null });
  });

  it("cleans the details: tags once each, FAQ without blanks, an update never before the publish", () => {
    const post = mapPost(
      apiPost({
        tags: [{ slug: "subtitles", name: "ซับไทย" }, { slug: "subtitles", name: "ซ้ำ" }, { slug: "BAD", name: "x" }],
        faq: [{ question: "", answer: "x" }, { question: "ถาม", answer: "ตอบ" }, "junk"],
        updated_at: "2026-09-01T00:00:00Z",
        source: "something",
        reading_minutes: "six",
        meta_title: "",
      }),
      MEDIA,
    )!;
    expect(post.tags).toEqual([{ slug: "subtitles", name: "ซับไทย" }]);
    expect(post.faq).toEqual([{ question: "ถาม", answer: "ตอบ" }]);
    expect(post.updatedAt).toBe(post.publishedAt);
    expect(post.source).toBe("ai");
    expect(post.readingMinutes).toBe(1);
    expect(post.metaTitle).toBe(post.title);
  });

  it("maps a listing page and its total", () => {
    const page = mapListPage({ items: [apiPost(), apiPost({ slug: "BAD" })], page: 2, per_page: 12, total: 13 }, MEDIA)!;
    expect(page.items.map((item) => item.slug)).toEqual(["thai-subtitles-tiktok-tips"]);
    expect(page).toMatchObject({ page: 2, perPage: 12, total: 13 });
    expect(mapListPage({ nope: true }, MEDIA)).toBeNull();
  });

  it("maps categories, tags and slugs", () => {
    expect(mapCategories([{ slug: "editing-tips", name: "เทคนิคตัดต่อ", description: "d", post_count: 3 }, { slug: "x" }])).toEqual([
      { slug: "editing-tips", name: "เทคนิคตัดต่อ", description: "d", postCount: 3 },
    ]);
    expect(mapTags([{ slug: "subtitles", name: "ซับไทย", post_count: 2 }])).toEqual([{ slug: "subtitles", name: "ซับไทย", postCount: 2 }]);
    expect(mapSlugs([{ slug: "a-b", updated_at: "2026-10-01T00:00:00Z" }, { slug: "a-b", updated_at: "2026-10-01T00:00:00Z" }, { slug: "c" }])).toEqual([
      { slug: "a-b", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(mapCategories({})).toBeNull();
  });
});

describe("blog URLs and requests", () => {
  it("validates slugs as the contract writes them", () => {
    expect(isBlogSlug("thai-subtitles-tiktok-tips")).toBe(true);
    for (const bad of ["", "-a", "a-", "a--b", "A", "ก", "a_b", "a/b", "a.md", "a".repeat(81), 3]) expect(isBlogSlug(bad), String(bad)).toBe(false);
  });

  it("reads ?page and writes canonical listing URLs", () => {
    expect(parsePageParam("2")).toBe(2);
    for (const bad of ["0", "01", "-1", "1.5", "abc", "10000", undefined]) expect(parsePageParam(bad), String(bad)).toBeNull();
    expect(withPage("/blog", 1)).toBe("/blog");
    expect(withPage("/blog/category/editing-tips", 3)).toBe("/blog/category/editing-tips?page=3");
    expect(pageCount(0)).toBe(1);
    expect(pageCount(12)).toBe(1);
    expect(pageCount(13)).toBe(2);
  });

  it("accepts a revalidation request of at most 20 valid slugs only", () => {
    expect(parseRevalidateSlugs({ slugs: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(parseRevalidateSlugs({ slugs: [] })).toEqual([]);
    expect(parseRevalidateSlugs({ slugs: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toBeNull();
    for (const bad of [null, [], "x", { slugs: "a" }, { slugs: ["../x"] }, { slugs: ["A"] }, { slugs: [1] }]) {
      expect(parseRevalidateSlugs(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("shows an update date only when the post changed on a later day", () => {
    expect(wasUpdated({ publishedAt: "2026-09-30T02:00:00Z", updatedAt: "2026-09-30T09:00:00Z" })).toBe(false);
    expect(wasUpdated({ publishedAt: "2026-09-30T02:00:00Z", updatedAt: "2026-10-01T04:30:00Z" })).toBe(true);
  });
});

describe("blog media base", () => {
  it("is the backend's default unless configured, and must be a plain http(s) URL", () => {
    expect(blogMediaBase(undefined)).toBe(MEDIA);
    expect(blogMediaBase("https://media.noeystudio.com/blog/")).toBe("https://media.noeystudio.com/blog");
    expect(blogMediaBase("ftp://x/blog")).toBeNull();
    expect(blogMediaBase("https://x/blog?a=1")).toBeNull();
  });

  it("lets next/image optimise exactly that https origin and path, nothing else", () => {
    expect(blogMediaRemotePattern(MEDIA)).toEqual({ protocol: "https", hostname: "api.noeystudio.com", port: "", pathname: "/blog/media/**", search: "" });
    expect(blogMediaRemotePattern("http://localhost:8010/blog/media")).toBeNull();
  });

  it("adds an img-src origin to the CSP only for a non-https base", () => {
    expect(blogMediaCspOrigin(MEDIA)).toBeNull();
    expect(blogMediaCspOrigin("http://localhost:8010/blog/media")).toBe("http://localhost:8010");
    expect(staticContentSecurityPolicy(null, null)).toBe(staticContentSecurityPolicy(null));
    expect(staticContentSecurityPolicy(null, "http://localhost:8010")).toContain("img-src 'self' data: blob: https: http://localhost:8010;");
  });

  it("matches only files under the base, never a path that climbs out", () => {
    expect(isUnderMediaBase(new URL(COVER), MEDIA)).toBe(true);
    expect(isUnderMediaBase(new URL("https://api.noeystudio.com/blog/mediax/a.webp"), MEDIA)).toBe(false);
    expect(isUnderMediaBase(new URL("https://api.noeystudio.com/blog/media/a.webp?x=1"), MEDIA)).toBe(false);
    expect(isUnderMediaBase(new URL("https://evil.example/blog/media/a.webp"), MEDIA)).toBe(false);
    expect(allowedImageUrl("https://user:pw@api.noeystudio.com/blog/media/a.webp", MEDIA)).toBeNull();
    expect(allowedImageUrl("data:image/png;base64,AAAA", MEDIA)).toBeNull();
  });
});
