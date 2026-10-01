import { describe, expect, it } from "vitest";
import { editProblems, fileSize, formatTags, mediaTextProblems, moveInPlan, parseInline, parseMarkdown, parseMediaTags, parseTags, safeHref, type PostEdit, validMediaKind, validPlanStatus, validRequestId, validSlug } from "./blog";

const edit = (over: Partial<PostEdit> = {}): PostEdit => ({
  title: "ชื่อบทความ",
  meta_title: "ชื่อสั้น",
  meta_description: "คำอธิบาย",
  excerpt: "บทคัดย่อ",
  content_md: "## หัวข้อ\n\nเนื้อหา",
  cover_image_url: null,
  cover_alt: null,
  category: "editing-tips",
  tags: [],
  faq: [],
  ...over,
});

describe("blog inputs", () => {
  it("accepts contract slugs only", () => {
    expect(validSlug("thai-subtitles-tips")).toBe(true);
    for (const bad of ["", "Thai", "a_b", "-a", "a--b", "ซับ", "x".repeat(81), 5]) expect(validSlug(bad)).toBe(false);
  });

  it("checks consent request ids", () => {
    expect(validRequestId("a".repeat(43))).toBe(true);
    expect(validRequestId("../admin")).toBe(false);
    expect(validRequestId("short")).toBe(false);
  });

  it("finds the contract's length limits", () => {
    expect(editProblems(edit())).toEqual([]);
    const p = editProblems(edit({ meta_title: "x".repeat(61), meta_description: "x".repeat(161), excerpt: "x".repeat(301) }));
    expect(p).toHaveLength(3);
    expect(editProblems(edit({ cover_image_url: "https://m/blog/a.webp" }))).toContain("รูปปกต้องมีคำอธิบายรูป (alt)");
    expect(editProblems(edit({ faq: [{ question: "q", answer: "" }] }))).toHaveLength(1);
    expect(editProblems(edit({ tags: [{ slug: "Bad Tag", name: null }] }))).toHaveLength(1);
  });

  it("round-trips tags", () => {
    const tags = parseTags("subtitles:ซับไทย, tips ,  ");
    expect(tags).toEqual([{ slug: "subtitles", name: "ซับไทย" }, { slug: "tips", name: null }]);
    expect(formatTags([{ slug: "subtitles", name: "ซับไทย" }, { slug: "tips", name: "tips" }])).toBe("subtitles:ซับไทย, tips");
  });
});

describe("markdown preview", () => {
  it("never produces a script URL", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/pricing")).toBe("/pricing");
    expect(safeHref("https://noeystudio.com/scope")).toBe("https://noeystudio.com/scope");
    expect(parseInline("[x](javascript:alert(1))").some((p) => p.kind === "link")).toBe(false);
    expect(parseInline("[x](javascript:void)")).toEqual([{ kind: "text", text: "x" }]);
  });

  it("builds blocks", () => {
    const blocks = parseMarkdown(
      "นำ **ตัวหนา** และ [ราคา](/pricing)\n\n## หัวข้อ\n\n- หนึ่ง\n- สอง\n\n1. ก\n2. ข\n\n![ภาพ](https://m.example/a.webp)\n\n```\n<script>x</script>\n```\n\n> คำพูด",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "h2", "ul", "ol", "img", "code", "quote"]);
    expect(blocks[0]).toEqual({
      kind: "p",
      inline: [
        { kind: "text", text: "นำ " }, { kind: "strong", text: "ตัวหนา" }, { kind: "text", text: " และ " },
        { kind: "link", text: "ราคา", href: "/pricing" },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "ul", items: [[{ kind: "text", text: "หนึ่ง" }], [{ kind: "text", text: "สอง" }]] });
    expect(blocks[5]).toEqual({ kind: "code", text: "<script>x</script>" });
  });
});

describe("media library, plan and preview helpers", () => {
  it("previews a visual and a clip without framing or playing anything", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const blocks = parseMarkdown(`::visual[แผนภาพ](${id})\n\n![คลิป](https://api.noeystudio.com/blog/media/${"b".repeat(64)}.mp4)\n\n::visual[x](nope)`);
    expect(blocks[0]).toEqual({ kind: "visual", alt: "แผนภาพ", id });
    expect(blocks[1]).toMatchObject({ kind: "video", alt: "คลิป" });
    expect(blocks[2].kind).toBe("p");
  });

  it("tags, text checks and plan moves", () => {
    expect(parseMediaTags(" Editor, timeline ,editor,, ซับไทย ")).toEqual(["editor", "timeline", "ซับไทย"]);
    expect(mediaTextProblems("ab", "")).toHaveLength(1);
    expect(mediaTextProblems("ภาพหน้าจอ", "x".repeat(1001))).toHaveLength(1);
    expect(moveInPlan([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveInPlan([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(validMediaKind("demo") && !validMediaKind("video")).toBe(true);
    expect(validPlanStatus("skipped") && !validPlanStatus("deleted")).toBe(true);
    expect(fileSize(1536)).toBe("2 KB");
  });
});
