import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sitemap from "../app/sitemap";
import { buildAtomFeed, feedEntryKeys } from "./feed";
import { ANSWERED_QUESTIONS, GUIDE_DOCS, GUIDE_ORDER } from "./guide";
import { buildGuideMarkdown, buildLlmsTxt, buildScopeMarkdown } from "./machine-readable";
import { OWNER_NUMBERS, ownerNumber, type OwnerNumberKey } from "./owner-numbers";
import { fallbackPriceTable } from "./plans";
import { markdownTwinPath, pageMetadata } from "./seo";
import { GUIDE_KEYS, PAGES, publishedDate, type PageKey } from "./site";

const contentKeys = (Object.keys(PAGES) as PageKey[]).filter((key) => PAGES[key].indexable);

/** Pages whose HTML twin is offered as Markdown (route folder `<path>.md`). */
const MARKDOWN_TWINS: PageKey[] = ["pricing", "scope", ...GUIDE_KEYS.filter((key) => key !== "guide")];

describe("guide documents", () => {
  it("registers every guide document as a page, and every guide page as a document", () => {
    expect([...GUIDE_ORDER]).toEqual(GUIDE_KEYS.filter((key) => key !== "guide"));
    for (const key of GUIDE_ORDER) {
      expect(PAGES[key].path.startsWith("/guide/"), `${key} path`).toBe(true);
      expect(GUIDE_DOCS[key].key).toBe(key);
    }
  });

  it("opens with one self-contained answer paragraph", () => {
    for (const key of GUIDE_ORDER) {
      const answer = GUIDE_DOCS[key].answer;
      // Thai has no word spaces, so length is measured in characters: this
      // band is the 40–60 word answer the AEO brief asks for.
      expect(answer.length, `${key} answer length`).toBeGreaterThanOrEqual(150);
      expect(answer.length, `${key} answer length`).toBeLessThanOrEqual(340);
      expect(answer.trim(), `${key} answer is one paragraph`).not.toMatch(/\n/);
    }
  });

  it("carries enough structure to be quoted: sections, FAQ and internal links", () => {
    for (const key of GUIDE_ORDER) {
      const doc = GUIDE_DOCS[key];
      expect(doc.sections.length, `${key} sections`).toBeGreaterThanOrEqual(5);
      expect(doc.faq.length, `${key} faq`).toBeGreaterThanOrEqual(4);
      expect(doc.related.length, `${key} related links`).toBeGreaterThanOrEqual(5);
      for (const section of doc.sections) {
        expect(section.paragraphs.length, `${key}/${section.id} paragraphs`).toBeGreaterThanOrEqual(1);
        const words = section.paragraphs.join("").length + (section.bullets ?? []).join("").length;
        expect(words, `${key}/${section.id} depth`).toBeGreaterThanOrEqual(240);
      }
      const paths = Object.values(PAGES).map((page) => page.path);
      for (const item of doc.related) expect(paths, `${key} link ${item.path}`).toContain(item.path);
      // A page must not list itself as further reading.
      expect(doc.related.map((item) => item.path)).not.toContain(PAGES[key].path);
    }
  });

  it("answers a distinct question per page", () => {
    const questions = ANSWERED_QUESTIONS.map((item) => item.question);
    expect(new Set(questions).size).toBe(questions.length);
    expect(ANSWERED_QUESTIONS.map((item) => item.path)).toEqual(GUIDE_ORDER.map((key) => PAGES[key].path));
  });
});

describe("dates", () => {
  it("gives every indexable page a content date and a published date", () => {
    for (const key of contentKeys) {
      expect(PAGES[key].updated, `${key} updated`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(publishedDate(key), `${key} published`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(publishedDate(key) <= PAGES[key].updated, `${key} published <= updated`).toBe(true);
    }
  });

  it("exposes both dates in page metadata, from the registry", () => {
    for (const key of contentKeys) {
      const meta = pageMetadata(key);
      expect(meta.other, `${key} date meta`).toMatchObject({
        date: publishedDate(key),
        "last-modified": PAGES[key].updated,
      });
      expect(meta.authors, `${key} author`).toEqual([{ name: "ทีมงาน Noey Studio" }]);
    }
  });

  it("marks guide pages as articles with published and modified times", () => {
    for (const key of GUIDE_KEYS) {
      const og = pageMetadata(key).openGraph as { type?: string; publishedTime?: string; modifiedTime?: string };
      expect(og.type, `${key} og type`).toBe("article");
      expect(og.publishedTime).toBe(publishedDate(key));
      expect(og.modifiedTime).toBe(PAGES[key].updated);
    }
    expect((pageMetadata("pricing").openGraph as { type?: string }).type).toBe("website");
  });
});

describe("feed", () => {
  const xml = buildAtomFeed();

  it("lists every indexable page, guide pages included, newest first", () => {
    for (const key of contentKeys) {
      expect(xml, `${key} entry`).toContain(`<id>https://noeystudio.com${PAGES[key].path === "/" ? "" : PAGES[key].path}</id>`);
    }
    const dates = feedEntryKeys().map((key) => PAGES[key].updated);
    expect([...dates]).toEqual([...dates].sort().reverse());
  });

  it("omits noindex pages", () => {
    expect(xml).not.toContain("/login");
  });

  it("is well-formed enough to parse: declared namespace, escaped text, self link", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://noeystudio.com/feed.xml"/>');
    expect(xml.match(/<entry>/g)?.length).toBe(contentKeys.length);
    // Raw "&" or "<" inside element text would break a parser.
    for (const text of xml.match(/<summary type="text">([^<]*)<\/summary>/g) ?? []) {
      expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    }
  });
});

describe("machine-readable surfaces", () => {
  const llms = buildLlmsTxt(fallbackPriceTable());

  it("lists every guide page, its Markdown twin and the answered questions in llms.txt", () => {
    for (const key of GUIDE_ORDER) {
      expect(llms, `${key} html link`).toContain(`https://noeystudio.com${PAGES[key].path})`);
      expect(llms, `${key} markdown link`).toContain(`https://noeystudio.com${PAGES[key].path}.md`);
      expect(llms, `${key} question`).toContain(GUIDE_DOCS[key].h1);
    }
    expect(llms).toContain("## คำถามที่ระบบตอบได้");
    expect(llms).toContain("## ข้อจำกัดที่ประกาศไว้");
    expect(llms).toContain("https://noeystudio.com/feed.xml");
    expect(llms).toContain("https://noeystudio.com/scope.md");
  });

  it("builds a Markdown twin holding the same answer, sections and FAQ as the page", () => {
    for (const key of GUIDE_ORDER) {
      const doc = GUIDE_DOCS[key];
      const md = buildGuideMarkdown(doc);
      expect(md.startsWith(`# ${doc.h1}`), `${key} heading`).toBe(true);
      expect(md).toContain(`> ${doc.answer}`);
      for (const section of doc.sections) expect(md, `${key}/${section.id}`).toContain(`## ${section.title}`);
      for (const item of doc.faq) expect(md).toContain(`### ${item.question}`);
      expect(md).toContain(`อัปเดตล่าสุด: ${PAGES[key].updated}`);
    }
  });

  it("builds a Markdown twin of /scope from the same scope copy", () => {
    const md = buildScopeMarkdown();
    expect(md).toContain("# ระบบคัดช็อตให้ แล้วคุณเกลาต่อ");
    expect(md).toContain("## เหมาะกับงานแบบไหน");
    expect(md).toContain("https://noeystudio.com/guide/help");
  });

  it("ships a .md route for every page that advertises one", () => {
    for (const key of MARKDOWN_TWINS) {
      const segments = markdownTwinPath(key).split("/").filter(Boolean);
      const route = join(process.cwd(), "src", "app", ...segments, "route.ts");
      expect(existsSync(route), `missing ${route}`).toBe(true);
    }
  });
});

describe("sitemap", () => {
  it("includes every guide page with its content date", () => {
    const entries = sitemap();
    for (const key of GUIDE_KEYS) {
      const entry = entries.find((row) => row.url === `https://noeystudio.com${PAGES[key].path}`);
      expect(entry, `${key} sitemap entry`).toBeDefined();
      expect(entry?.lastModified).toBe(PAGES[key].updated);
    }
    expect(entries.every((row) => !!row.lastModified)).toBe(true);
  });
});

describe("owner-supplied numbers", () => {
  it("renders nothing while a number has not been measured", () => {
    for (const key of Object.keys(OWNER_NUMBERS) as OwnerNumberKey[]) {
      const entry = OWNER_NUMBERS[key];
      // A value without a measurement date is not publishable.
      if (!entry.measured) expect(ownerNumber(key), `${key}`).toBeNull();
      expect(entry.note.length, `${key} note`).toBeGreaterThan(10);
    }
  });

  it("keeps unmeasured numbers out of every published surface", () => {
    const surfaces = [
      buildLlmsTxt(fallbackPriceTable()),
      buildScopeMarkdown(),
      ...GUIDE_ORDER.map((key) => buildGuideMarkdown(GUIDE_DOCS[key])),
    ].join("\n");
    // Phrases that would only appear if a measured claim had been invented.
    expect(surfaces).not.toMatch(/เร็วขึ้น \d+ ?%|ประหยัดเวลา \d+ ?%|แม่นยำ \d+ ?%|ผู้ใช้กว่า/);
  });
});
