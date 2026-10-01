import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlogVideo } from "@/components/blog/BlogVideo";
import { BlogVisual } from "@/components/blog/BlogVisual";
import { mapMedia, mapPost, type BlogPost } from "./blog";
import { describeVisuals } from "./blog-machine";
import { articleParts, isVideoSrc, visualOf, markdownToHast } from "./blog-markdown";
import { blogEmbedOrigin, visualSrc } from "./blog-media";
import { bodyMediaJsonLd, postJsonLd } from "./blog-seo";
import { staticContentSecurityPolicy } from "./csp";
import { isoDuration } from "./jsonld";

const MEDIA = "https://api.noeystudio.com/blog/media";
const EMBED = "https://embed.noeystudio.com";
const ID = "0123456789abcdef0123456789abcdef";
const IMG = `${MEDIA}/${"a".repeat(64)}.webp`;
const CLIP = `${MEDIA}/${"b".repeat(64)}.mp4`;
const POSTER = `${MEDIA}/${"c".repeat(64)}.webp`;

const API_MEDIA = [
  { type: "visual", id: ID, src: "https://evil.example/visual/x", width: 1600, height: 1000, alt: "แผนภาพ", caption: "สามขั้นตอน", animated: true },
  { type: "image", url: IMG, alt: "ภาพหน้าจอ", width: 2400, height: 1200 },
  { type: "video", url: CLIP, poster_url: POSTER, alt: "คลิปสาธิต", width: 1280, height: 720, duration_sec: 5.4 },
];

describe("visual placeholders in Markdown", () => {
  it("turns a ::visual line into a placeholder, and nothing else", () => {
    const parts = articleParts(`คำตอบ\n\n## หัวข้อ\n\n::visual[แผนภาพสามขั้นตอน](${ID})\n\nข้อความ ::visual[x](${ID}) กลางประโยค\n\n::visual[ผิด](abc)\n`);
    const children = parts.sections[0].children.filter((node) => node.type === "element");
    const placeholder = children[0];
    expect(placeholder).toMatchObject({ tagName: "div", properties: { dataVisual: ID, dataAlt: "แผนภาพสามขั้นตอน" } });
    expect(children.filter((node) => node.type === "element" && node.tagName === "div")).toHaveLength(1);
  });

  it("only a well-formed id counts, and raw HTML around it is still dropped", () => {
    const root = markdownToHast(`::visual[x](${ID})\n\n<iframe src="https://evil.example"></iframe>\n\n::visual[x](javascript:alert(1))`);
    const found = root.children.map(visualOf).filter(Boolean);
    expect(found).toEqual([{ id: ID, alt: "x" }]);
    expect(JSON.stringify(root)).not.toMatch(/iframe|javascript/);
  });

  it("marks only the first video", () => {
    const parts = articleParts(`คำตอบ\n\n## หัวข้อ\n\n![a](${CLIP})\n\n![b](${CLIP.replace("b", "d")})\n`);
    const videos = parts.sections[0].children.filter((node) => node.type === "element" && node.tagName === "img");
    expect(videos.map((node) => node.type === "element" && "dataFirstVideo" in (node.properties ?? {}))).toEqual([true, false]);
    expect(isVideoSrc(`${CLIP}?x=1`)).toBe(true);
    expect(isVideoSrc(IMG)).toBe(false);
  });

  it("the Markdown twin describes a visual instead of printing its id", () => {
    expect(describeVisuals(`ก่อน\n\n::visual[แผนภาพ](${ID})\n\nหลัง`)).toBe("ก่อน\n\n*[ภาพประกอบ: แผนภาพ]*\n\nหลัง");
  });
});

describe("media mapping", () => {
  it("builds the visual URL itself, from the configured embed origin only", () => {
    const media = mapMedia(API_MEDIA, MEDIA, EMBED);
    expect(media[0]).toEqual({ type: "visual", id: ID, src: `${EMBED}/visual/${ID}`, alt: "แผนภาพ", caption: "สามขั้นตอน", width: 1600, height: 1000, animated: true });
    expect(media[2]).toMatchObject({ type: "video", posterUrl: POSTER, durationSec: 5.4, width: 1280 });
    expect(mapMedia(API_MEDIA, MEDIA, null).map((item) => item.type)).toEqual(["image", "video"]);
  });

  it("drops media outside the store and visuals with bad ids or sizes", () => {
    const out = mapMedia(
      [
        { type: "image", url: "https://evil.example/x.webp", width: 1, height: 1 },
        { type: "video", url: CLIP, poster_url: "https://evil.example/p.webp" },
        { type: "visual", id: "../../x", width: 1600, height: 1000 },
        { type: "visual", id: ID, width: 0, height: 1000 },
        { type: "script", url: IMG },
      ],
      MEDIA,
      EMBED,
    );
    expect(out).toEqual([{ type: "video", url: CLIP, posterUrl: null, alt: "", width: null, height: null, durationSec: null }]);
  });

  it("the embed origin is https unless the local flag allows http", () => {
    expect(blogEmbedOrigin(undefined, false)).toBe(EMBED);
    expect(blogEmbedOrigin("http://127.0.0.1:8030", false)).toBeNull();
    expect(blogEmbedOrigin("http://127.0.0.1:8030/", true)).toBe("http://127.0.0.1:8030");
    expect(blogEmbedOrigin("https://embed.noeystudio.com/?x=1", false)).toBeNull();
    expect(visualSrc("nope", EMBED)).toBeNull();
  });
});

describe("the visual and video markup", () => {
  it("is the spec's sandboxed, image-like iframe", () => {
    const html = renderToStaticMarkup(createElement(BlogVisual, { src: `${EMBED}/visual/${ID}`, alt: "แผนภาพ", caption: "สามขั้นตอน", width: 1600, height: 1000 }));
    expect(html).toContain('<figure class="visual" style="aspect-ratio:1600 / 1000">');
    expect(html).toContain(`src="${EMBED}/visual/${ID}"`);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    for (const attr of ['loading="lazy"', 'tabindex="-1"', 'aria-hidden="true"', 'scrolling="no"', 'referrerPolicy="no-referrer"', 'title=""']) {
      expect(html).toContain(attr);
    }
    expect(html).toContain("width:100%;height:100%;border:0;display:block;pointer-events:none");
    expect(html).toContain('<span class="sr-only">แผนภาพ</span><figcaption>สามขั้นตอน</figcaption>');
  });

  it("a clip is never autoplaying in the server HTML (reduced motion is checked first)", () => {
    const first = renderToStaticMarkup(createElement(BlogVideo, { src: CLIP, poster: POSTER, alt: "คลิป", caption: "คลิป", width: 1280, height: 720, first: true }));
    const later = renderToStaticMarkup(createElement(BlogVideo, { src: CLIP, poster: POSTER, alt: "คลิป", caption: "", width: 1280, height: 720, first: false }));
    expect(first).not.toContain("autoplay");
    expect(first).toMatch(/<video[^>]*muted=""[^>]*loop=""[^>]*playsInline=""[^>]*controls=""[^>]*preload="metadata"[^>]*poster="[^"]+"/);
    expect(later).toContain('preload="none"');
    expect(later).toContain('aria-label="คลิป"');
    expect(first).toContain("<figcaption>คลิป</figcaption>");
  });
});

describe("structured data and CSP", () => {
  const post = mapPost(
    {
      slug: "media-post",
      title: "บทความที่มีภาพ",
      meta_title: "บทความที่มีภาพ",
      meta_description: "คำอธิบาย",
      excerpt: "สรุป",
      content_md: `คำตอบ\n\n## หัวข้อ\n\n::visual[แผนภาพ](${ID})\n\n![ภาพหน้าจอ](${IMG})\n\n![คลิปสาธิต](${CLIP})`,
      cover_image_url: `${MEDIA}/${"e".repeat(64)}.webp`,
      cover_alt: "ปก",
      cover_width: 1600,
      cover_height: 900,
      category: { slug: "editing-tips", name: "เทคนิคตัดต่อ" },
      tags: [],
      faq: [],
      author: "Noey Studio",
      source: "ai",
      reading_minutes: 3,
      published_at: "2026-10-02T02:00:00Z",
      updated_at: "2026-10-02T02:00:00Z",
      related: [],
      media: API_MEDIA,
    },
    MEDIA,
    EMBED,
  ) as BlogPost;

  it("Article.image lists the cover and the library images; clips are VideoObjects; visuals are not images", () => {
    const extra = bodyMediaJsonLd(post);
    expect(extra.bodyImages).toEqual([{ url: IMG, width: 2400, height: 1200 }]);
    expect(extra.videos?.[0]).toMatchObject({ contentUrl: CLIP, thumbnailUrl: POSTER, duration: 5.4, uploadDate: "2026-10-02T02:00:00.000Z" });
    const graph = postJsonLd(post, [{ name: "หน้าแรก", path: "/" }]) as { "@graph": Record<string, unknown>[] };
    const article = graph["@graph"].find((node) => node["@type"] === "BlogPosting")!;
    expect((article.image as { url: string }[]).map((image) => image.url)).toEqual([post.cover!.url, IMG]);
    expect(article.video).toEqual([
      expect.objectContaining({ "@type": "VideoObject", name: "คลิปสาธิต", contentUrl: CLIP, thumbnailUrl: POSTER, duration: "PT5S" }),
    ]);
    expect(JSON.stringify(graph)).not.toContain("/visual/");
    expect(isoDuration(75)).toBe("PT1M15S");
    expect(isoDuration(60)).toBe("PT1M");
  });

  it("frame-src gains exactly the embed origin", () => {
    const csp = staticContentSecurityPolicy(null, null, EMBED);
    expect(csp).toContain(`frame-src https://challenges.cloudflare.com ${EMBED}`);
    expect(staticContentSecurityPolicy(null, "http://localhost:8030", "http://127.0.0.1:8030")).toContain("media-src 'self' blob: https: http://localhost:8030");
    expect(staticContentSecurityPolicy(null)).toContain("frame-src https://challenges.cloudflare.com;");
  });
});
