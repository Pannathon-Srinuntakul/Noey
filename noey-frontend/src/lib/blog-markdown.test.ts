import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { articleParts, headingSlug, linkTarget, markdownToHast } from "./blog-markdown";
import DATA from "./server/__fixtures__/blog.json";

/** The tree as HTML, rendered by React exactly as the page renders it (minus the site's components). */
function html(markdown: string): string {
  return renderToStaticMarkup(toJsxRuntime(markdownToHast(markdown), { Fragment, jsx, jsxs }));
}

describe("blog Markdown: untrusted input", () => {
  it("drops raw HTML entirely, script and event handlers included", () => {
    const out = html(
      [
        "ก่อน <script>alert(1)</script> หลัง",
        "",
        '<img src=x onerror="alert(1)">',
        "",
        "<iframe src='https://evil.example'></iframe>",
        "",
        '<a href="javascript:alert(1)">x</a>',
        "",
        "<style>body{display:none}</style>",
      ].join("\n"),
    );
    expect(out).not.toMatch(/<script|<iframe|<style|onerror|javascript:/i);
    expect(out).toContain("ก่อน");
    expect(out).toContain("หลัง");
  });

  it("removes dangerous link and image URLs but keeps site paths, anchors, https and mailto", () => {
    const out = html(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](/pricing) [d](#faq) [e](https://example.com) [f](mailto:hello@noeystudio.com) ![g](javascript:x)",
    );
    expect(out).not.toMatch(/javascript:|data:text/);
    expect(out).toContain('href="/pricing"');
    expect(out).toContain('href="#faq"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="mailto:hello@noeystudio.com"');
  });

  it("renders GitHub-flavoured Markdown: tables, task lists, strikethrough", () => {
    const out = html("| ก | ข |\n| --- | --- |\n| 1 | 2 |\n\n- [x] เสร็จ\n- [ ] ยัง\n\n~~เก่า~~");
    expect(out).toContain("<table>");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("<del>");
  });
});

describe("blog Markdown: the article's parts", () => {
  const md = [
    "คำตอบแรกของบทความ [ดูราคา](/pricing)",
    "",
    "![ภาพประกอบ](https://api.noeystudio.com/blog/media/x.webp)",
    "",
    "## ซับหนึ่งบรรทัดควรยาวแค่ไหน",
    "",
    "เนื้อหา",
    "",
    "### แบ่งประโยคยังไง",
    "",
    "เนื้อหาย่อย",
    "",
    "# หัวข้อที่เขียนผิดระดับ",
    "",
    "## ซับหนึ่งบรรทัดควรยาวแค่ไหน",
    "",
    "## FAQ",
    "",
    "```",
    "<b>code stays code</b> โปรเจกต์",
    "```",
  ].join("\n");
  const parts = articleParts(md);

  it("leads with the opening paragraph and keeps a picture before the first section in the intro", () => {
    expect(parts.answer?.tagName).toBe("p");
    expect(parts.intro.map((node) => (node.type === "element" ? node.tagName : node.type))).toEqual(["img"]);
    const image = parts.intro[0];
    expect(image.type === "element" && image.properties.dataStandalone).toBe("");
    expect(image.type === "element" && image.properties.dataEager).toBe("");
  });

  it("keeps a captioned picture's title (the figure's caption) in the fixture post that has one", () => {
    const post = DATA.posts.find((item) => item.slug === "check-subtitle-blocks-before-render");
    const sections = articleParts(post?.content_md ?? "").sections;
    const image = sections.flatMap((section) => section.children).find((node) => node.type === "element" && node.tagName === "img");
    expect(image?.type === "element" && image.properties.dataStandalone).toBe("");
    expect(image?.type === "element" && image.properties.title).toBe("เลนคำบรรยาย: แต่ละประโยคเป็นบล็อกที่แก้ข้อความได้");
    expect(image?.type === "element" && image.properties.alt).toBe("ภาพประกอบ เลนคำบรรยายในไทม์ไลน์ แต่ละประโยคเป็นบล็อกแยกกัน");
  });

  it("gives every ## and ### a unique anchor and lists them as the table of contents", () => {
    expect(parts.toc).toEqual([
      { id: "ซับหนึ่งบรรทัดควรยาวแค่ไหน", text: "ซับหนึ่งบรรทัดควรยาวแค่ไหน", cue: "01", depth: 1 },
      { id: "แบ่งประโยคยังไง", text: "แบ่งประโยคยังไง", cue: "01.1", depth: 2 },
      { id: "หัวข้อที่เขียนผิดระดับ", text: "หัวข้อที่เขียนผิดระดับ", cue: "02", depth: 1 },
      { id: "ซับหนึ่งบรรทัดควรยาวแค่ไหน-2", text: "ซับหนึ่งบรรทัดควรยาวแค่ไหน", cue: "03", depth: 1 },
      // "faq" is the page's own section: the heading takes another id.
      { id: "faq-2", text: "FAQ", cue: "04", depth: 1 },
    ]);
    // The stray # became a ## (the page keeps one H1).
    expect(parts.sections[1].heading.tagName).toBe("h2");
  });

  it("wraps Thai runs for line breaking, but never inside code", () => {
    const code = parts.sections.at(-1)!.children.find((node) => node.type === "element" && node.tagName === "pre");
    expect(JSON.stringify(code)).not.toContain('"kt"');
    expect(JSON.stringify(code)).toContain("<b>code stays code</b>");
  });

  it("makes anchors from Thai and Latin text", () => {
    expect(headingSlug("ซับไทย: อ่านทันแค่ไหน?")).toBe("ซับไทย-อ่านทันแค่ไหน");
    expect(headingSlug("Step 1 — Upload")).toBe("step-1-upload");
    expect(headingSlug("!!!")).toBe("section");
  });
});

describe("blog links", () => {
  const hosts = ["noeystudio.com", "www.noeystudio.com"];
  it("treats site paths and the site's own absolute URLs as internal, the rest as external", () => {
    expect(linkTarget("/pricing", hosts)).toEqual({ kind: "internal", href: "/pricing" });
    expect(linkTarget("https://www.noeystudio.com/guide/help#modes", hosts)).toEqual({ kind: "internal", href: "/guide/help#modes" });
    expect(linkTarget("#faq", hosts)).toEqual({ kind: "anchor", href: "#faq" });
    expect(linkTarget("https://www.tiktok.com/", hosts)).toEqual({ kind: "external", href: "https://www.tiktok.com/" });
    expect(linkTarget("//evil.example", hosts)).toBeNull();
    expect(linkTarget("javascript:alert(1)", hosts)).toBeNull();
    expect(linkTarget("ftp://x", hosts)).toBeNull();
  });
});
