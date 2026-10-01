import { afterEach, describe, expect, it, vi } from "vitest";
import sitemap from "@/app/sitemap";
import { mapPost, type BlogPost } from "./blog";
import { absolutizeMarkdownLinks, blogSitemapEntries, buildBlogFeed, buildPostMarkdown, llmsBlogLines } from "./blog-machine";
import { listingJsonLd, listingMetadata, postJsonLd, postMetadata, postTitle } from "./blog-seo";
import { buildAtomFeed } from "./feed";
import { serializeJsonLd } from "./jsonld";
import { buildLlmsTxt } from "./machine-readable";
import { fallbackPriceTable } from "./plans";
import DATA from "./server/__fixtures__/blog.json";

const MEDIA = "https://api.noeystudio.com/blog/media";
const posts = DATA.posts.map((post) => mapPost(post, MEDIA)!) as BlogPost[];
const withCover = posts.find((post) => post.cover && post.faq.length)!;
const noCover = posts.find((post) => !post.cover)!;
const noFaq = posts.find((post) => post.faq.length === 0)!;
const trail = (post: BlogPost) => [
  { name: "หน้าแรก", path: "/" },
  { name: "บทความ", path: "/blog" },
  { name: post.category.name, path: `/blog/category/${post.category.slug}` },
  { name: post.title, path: `/blog/${post.slug}` },
];
const graph = (data: Record<string, unknown>) => data["@graph"] as Array<Record<string, unknown>>;
const node = (data: Record<string, unknown>, type: string) => graph(data).find((item) => item["@type"] === type);

describe("blog JSON-LD", () => {
  it("describes a post as a BlogPosting by the Organization, with FAQPage when it has FAQ, and its breadcrumbs", () => {
    const data = postJsonLd(withCover, trail(withCover));
    const article = node(data, "BlogPosting")!;
    expect(article).toMatchObject({
      "@id": `https://noeystudio.com/blog/${withCover.slug}#article`,
      headline: withCover.title,
      description: withCover.metaDescription,
      datePublished: withCover.publishedAt,
      dateModified: withCover.updatedAt,
      inLanguage: "th",
      image: { "@type": "ImageObject", url: withCover.cover!.url, width: withCover.cover!.width, height: withCover.cover!.height },
      author: { "@type": "Organization", name: "Noey Studio" },
      publisher: { "@id": "https://noeystudio.com/#organization" },
      mainEntityOfPage: { "@id": `https://noeystudio.com/blog/${withCover.slug}#webpage` },
      articleSection: withCover.category.name,
    });
    expect(node(data, "Organization")).toMatchObject({ name: "Noey Studio" });
    const faq = node(data, "FAQPage")!;
    expect((faq.mainEntity as unknown[]).length).toBe(withCover.faq.length);
    const crumbs = node(data, "BreadcrumbList")!;
    expect((crumbs.itemListElement as Array<{ name: string }>).map((item) => item.name)).toEqual(trail(withCover).map((crumb) => crumb.name));
    expect(serializeJsonLd(data)).not.toMatch(/AggregateRating|"Review"/);
  });

  it("leaves FAQPage out when the post has no FAQ, and points a post without a cover at its generated image", () => {
    expect(node(postJsonLd(noFaq, trail(noFaq)), "FAQPage")).toBeUndefined();
    expect(node(postJsonLd(noCover, trail(noCover)), "BlogPosting")!.image).toEqual({
      "@type": "ImageObject",
      url: `https://noeystudio.com/blog/${noCover.slug}/opengraph-image`,
      width: 1200,
      height: 630,
    });
  });

  it("describes /blog as a Blog with an ItemList of the page's posts", () => {
    const data = listingJsonLd({ path: "/blog", page: 1, name: "บทความ", description: "d", posts, trail: trail(posts[0]).slice(0, 2), isBlogIndex: true });
    expect((node(data, "Blog")!.blogPost as unknown[]).length).toBe(posts.length);
    expect((node(data, "ItemList")!.itemListElement as Array<{ url: string }>)[0].url).toBe(`https://noeystudio.com/blog/${posts[0].slug}`);
    expect(node(data, "CollectionPage")).toBeDefined();
    const category = listingJsonLd({ path: "/blog/category/x", page: 2, name: "x", description: "d", posts: [], trail: [], isBlogIndex: false });
    expect(node(category, "Blog")).toBeUndefined();
    expect(node(category, "CollectionPage")!.url).toBe("https://noeystudio.com/blog/category/x?page=2");
    expect(node(category, "CollectionPage")!.dateModified).toBeUndefined();
  });
});

describe("blog metadata", () => {
  it("gives a post its canonical, article OG tags, its cover as the share image and the Markdown twin", () => {
    const meta = postMetadata(withCover);
    expect(meta.alternates?.canonical).toBe(`https://noeystudio.com/blog/${withCover.slug}`);
    expect(meta.alternates?.types).toMatchObject({ "text/markdown": `/blog/${withCover.slug}.md` });
    expect(meta.openGraph).toMatchObject({
      type: "article",
      publishedTime: withCover.publishedAt,
      modifiedTime: withCover.updatedAt,
      section: withCover.category.name,
      tags: withCover.tags.map((tag) => tag.name),
    });
    expect((meta.openGraph as { images: Array<{ url: string }> }).images[0].url).toBe(withCover.cover!.url);
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
    // No cover: no explicit image, so the segment's generated opengraph-image applies.
    expect((postMetadata(noCover).openGraph as { images?: unknown }).images).toBeUndefined();
  });

  it("adds the brand to a post's title once", () => {
    expect(postTitle({ metaTitle: "ซับไทย | Noey Studio", title: "x" })).toBe("ซับไทย | Noey Studio");
    expect(postTitle({ metaTitle: "ซับไทย", title: "x" })).toBe("ซับไทย | Noey Studio");
  });

  it("gives every listing page a self-canonical and rel=prev/next", () => {
    const meta = listingMetadata({ path: "/blog", title: "บทความ", description: "d", page: 2, last: 3, indexable: true });
    expect(meta.alternates?.canonical).toBe("https://noeystudio.com/blog?page=2");
    expect(meta.pagination).toEqual({ previous: "https://noeystudio.com/blog", next: "https://noeystudio.com/blog?page=3" });
    expect(meta.title).toEqual({ absolute: "บทความ · หน้า 2 | Noey Studio" });
    const thin = listingMetadata({ path: "/blog/tag/x", title: "t", description: "d", page: 1, last: 1, indexable: false });
    expect(thin.robots).toMatchObject({ index: false, follow: true });
    expect(thin.pagination).toEqual({ previous: undefined, next: undefined });
  });
});

describe("blog feeds, sitemap, llms.txt, Markdown twin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("/blog/feed.xml lists the posts with their own dates, escaped", () => {
    const xml = buildBlogFeed(posts);
    expect(xml.match(/<entry>/g)?.length).toBe(posts.length);
    expect(xml).toContain(`<id>https://noeystudio.com/blog/${posts[0].slug}</id>`);
    expect(xml).toContain(`<updated>${posts[0].updatedAt}</updated>`);
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://noeystudio.com/blog/feed.xml"/>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(buildBlogFeed([])).toContain("<updated>2026-10-01T00:00:00+07:00</updated>");
  });

  it("/feed.xml mixes the posts in with the pages, newest first", () => {
    const xml = buildAtomFeed(posts);
    for (const post of posts) expect(xml).toContain(`https://noeystudio.com/blog/${post.slug}`);
    const updated = [...xml.matchAll(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/g)].map((match) => Date.parse(match[1]));
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    expect(buildAtomFeed([])).not.toContain("/blog/");
  });

  it("the sitemap lists /blog, the listings with posts and every published post with its updated_at", async () => {
    const entries = blogSitemapEntries({
      slugs: [
        { slug: "a", updatedAt: "2026-10-01T00:00:00.000Z" },
        { slug: "b", updatedAt: "2026-09-01T00:00:00.000Z" },
      ],
      categories: [{ slug: "editing-tips", lastModified: "2026-10-01T00:00:00.000Z" }],
      tags: [],
    });
    expect(entries).toEqual([
      { url: "https://noeystudio.com/blog", lastModified: "2026-10-01T00:00:00.000Z" },
      { url: "https://noeystudio.com/blog/category/editing-tips", lastModified: "2026-10-01T00:00:00.000Z" },
      { url: "https://noeystudio.com/blog/a", lastModified: "2026-10-01T00:00:00.000Z" },
      { url: "https://noeystudio.com/blog/b", lastModified: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(blogSitemapEntries({ slugs: [], categories: [], tags: [] })).toEqual([]);

    // The real sitemap, fed by the fixtures (the API stand-in in tests).
    vi.stubEnv("BLOG_FIXTURES", "1");
    const urls = (await sitemap()).map((entry) => entry.url);
    for (const post of DATA.posts) expect(urls).toContain(`https://noeystudio.com/blog/${post.slug}`);
    expect(urls).toContain("https://noeystudio.com/blog");
    expect(urls).toContain("https://noeystudio.com/blog/category/subtitles-audio");
  });

  it("llms.txt names the newest posts with their Markdown twins, and no AI vendor", () => {
    const text = buildLlmsTxt(fallbackPriceTable(), posts);
    expect(text).toContain("## บทความล่าสุด");
    expect(text).toContain(`](https://noeystudio.com/blog/${posts[0].slug}): `);
    expect(text).toContain(`Markdown: https://noeystudio.com/blog/${posts[0].slug}.md`);
    expect(text).toContain("](https://noeystudio.com/blog/feed.xml)");
    expect(text).not.toMatch(/gemini|claude|openai|chatgpt|elevenlabs|anthropic/i);
    expect(llmsBlogLines([])).toEqual([]);
  });

  it("the Markdown twin carries the header, the body with absolute links, the FAQ and related posts", () => {
    const md = buildPostMarkdown(withCover);
    expect(md.startsWith(`# ${withCover.title}\n`)).toBe(true);
    expect(md).toContain(`- หน้าเว็บ: https://noeystudio.com/blog/${withCover.slug}`);
    expect(md).toContain("](https://noeystudio.com/guide/thai-subtitles)");
    expect(md).toContain("## คำถามที่พบบ่อย");
    expect(md).toContain(`### ${withCover.faq[0].question}`);
    expect(absolutizeMarkdownLinks("[a](/x) [b](https://e.com) [c](//e.com)")).toBe("[a](https://noeystudio.com/x) [b](https://e.com) [c](//e.com)");
  });
});
