/**
 * A blog post's Markdown → a sanitised HTML tree (hast), cut into the parts
 * the article page lays out. Pure and synchronous: React rendering happens in
 * components/blog/ArticleBody.tsx, which maps the tree's elements to the
 * site's own components.
 *
 * Content from the API is untrusted:
 *  - raw HTML is never parsed into elements (`allowDangerousHtml: false`
 *    drops every HTML node, `<script>` included);
 *  - the tree is then sanitised with GitHub's schema (rehype-sanitize), which
 *    removes event handlers, `style`, and every URL scheme but http(s)/mailto
 *    (relative links and #anchors stay);
 *  - nothing here ends up in dangerouslySetInnerHTML.
 *
 * GitHub-flavoured Markdown: tables, task lists, strikethrough, autolinks
 * and footnotes.
 *
 * Pictures beyond plain images (BLOG_CONTRACT.md, "Changes" 2026-10-02):
 *  - `::visual[alt](id)` alone in its paragraph is an HTML visual. Markdown
 *    reads it as the text "::visual" followed by a link; after sanitising,
 *    such a paragraph becomes a `<div data-visual="<id>" data-alt="…">`
 *    placeholder that ArticleBody draws as the sandboxed iframe. Anything
 *    else that merely looks like it stays plain text.
 *  - `![alt](….mp4)` is a library video; the first one in the post is marked
 *    `data-first-video` (it alone preloads metadata).
 */
import type { Element, ElementContent, Root, RootContent } from "hast";
import { toString } from "hast-util-to-string";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { thaiProseRuns } from "@/components/ds/ThaiProse";

export interface TocEntry {
  id: string;
  text: string;
  /** "01" for a section, "01.2" for a subsection in it. */
  cue: string;
  depth: 1 | 2;
}

export interface ArticleSection {
  id: string;
  title: string;
  cue: string;
  heading: Element;
  /** Everything after the heading up to the next section. */
  children: ElementContent[];
}

export interface ArticleParts {
  /** The opening paragraph, when the post starts with one: the answer the page leads with. */
  answer: Element | null;
  /** Anything else before the first section heading. */
  intro: ElementContent[];
  sections: ArticleSection[];
  toc: TocEntry[];
}

/** Ids the page itself uses next to the article; a heading never takes one. */
const RESERVED_IDS = new Set(["main", "page-title", "faq", "related", "guides", "blog-cta", "blog-cta-title", "tags", "contents"]);

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    allowDangerousHtml: false,
    footnoteLabel: "เชิงอรรถ",
    footnoteBackLabel: (index: number) => `กลับไปที่เนื้อหา (เชิงอรรถ ${index + 1})`,
  })
  .use(rehypeSanitize);

/** Markdown → sanitised hast. */
export function markdownToHast(markdown: string): Root {
  return processor.runSync(processor.parse(markdown)) as Root;
}

const isElement = (node: RootContent | ElementContent | undefined, tag?: string): node is Element =>
  !!node && node.type === "element" && (!tag || node.tagName === tag);

const isBlank = (node: RootContent | ElementContent) => node.type === "text" && !node.value.trim();

/** A heading's text as an anchor: Thai and Latin letters, marks and digits, joined by hyphens. */
export function headingSlug(text: string): string {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "section";
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id) || RESERVED_IDS.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

const VISUAL_ID = /^[0-9a-f]{32}$/;

/** The id of a `::visual[alt](id)` paragraph, with its alt text; null for any other node. */
export function visualOf(node: RootContent | ElementContent): { id: string; alt: string } | null {
  if (!isElement(node, "p")) return null;
  const content = node.children.filter((child) => !isBlank(child));
  if (content.length !== 2) return null;
  const [marker, link] = content;
  if (marker.type !== "text" || marker.value.trim() !== "::visual" || !isElement(link, "a")) return null;
  const id = link.properties?.href;
  if (typeof id !== "string" || !VISUAL_ID.test(id)) return null;
  return { id, alt: toString(link).trim() };
}

/** A video in a post is an image node whose URL ends in .mp4. */
export function isVideoSrc(src: unknown): boolean {
  return typeof src === "string" && /\.mp4$/i.test(src.split(/[?#]/)[0]);
}

/**
 * A paragraph that holds nothing but one image becomes that image, marked
 * standalone (drawn as a figure): a <figure> may not sit inside a <p>. A
 * `::visual` paragraph becomes the visual's placeholder.
 */
function liftStandaloneImages(nodes: RootContent[]): RootContent[] {
  return nodes.map((node) => {
    const visual = visualOf(node);
    if (visual) {
      return { type: "element", tagName: "div", properties: { dataVisual: visual.id, dataAlt: visual.alt }, children: [] } as Element;
    }
    if (!isElement(node, "p")) return node;
    const content = node.children.filter((child) => !isBlank(child));
    if (content.length === 1 && isElement(content[0], "img")) {
      const image = content[0];
      return { ...image, properties: { ...image.properties, dataStandalone: "" } };
    }
    return node;
  });
}

/** Marks the first video of the post (in reading order) — the one that preloads metadata. */
function markFirstVideo(nodes: readonly (RootContent | ElementContent)[], state = { done: false }): void {
  for (const node of nodes) {
    if (state.done) return;
    if (node.type !== "element") continue;
    if (node.tagName === "img" && isVideoSrc(node.properties?.src)) {
      node.properties = { ...node.properties, dataFirstVideo: "" };
      state.done = true;
      return;
    }
    markFirstVideo(node.children, state);
  }
}

/** Elements whose text is code or drawing, never prose. */
const NOT_PROSE = new Set(["pre", "code", "kbd", "samp", "svg"]);

/**
 * Thai line breaking, the same as every other long text on the site
 * (keepThaiProse): runs that must not break inside are wrapped in `.kt`
 * spans. Code is left alone.
 */
export function wrapThaiRuns(node: Root | Element): void {
  const out: (RootContent | ElementContent)[] = [];
  for (const child of node.children) {
    if (child.type === "text" && /[฀-๿]/.test(child.value)) {
      const runs = thaiProseRuns(child.value);
      for (const run of runs) {
        out.push(
          run.keep
            ? { type: "element", tagName: "span", properties: { className: ["kt"] }, children: [{ type: "text", value: run.text }] }
            : { type: "text", value: run.text },
        );
      }
      continue;
    }
    if (child.type === "element" && !NOT_PROSE.has(child.tagName)) wrapThaiRuns(child);
    out.push(child);
  }
  node.children = out as typeof node.children;
}

/**
 * Splits a post into answer, intro and sections, and gives every h2/h3 an
 * id. The body's headings start at ## by contract; a stray # is demoted so
 * the page keeps one H1.
 */
export function articleParts(markdown: string): ArticleParts {
  const root = markdownToHast(markdown);
  wrapThaiRuns(root);
  // Visual placeholders and the first video, before the parts are cut up.
  const lifted = liftStandaloneImages(root.children);
  markFirstVideo(lifted);
  const nodes = lifted.filter((node) => node.type !== "doctype" && !isBlank(node));
  const used = new Set<string>();
  const parts: ArticleParts = { answer: null, intro: [], sections: [], toc: [] };
  let sub = 0;

  for (const node of nodes) {
    if (node.type === "comment" || node.type === "doctype") continue;
    const section = parts.sections.at(-1);
    if (node.type === "element" && (node.tagName === "h1" || node.tagName === "h2")) {
      node.tagName = "h2";
      const title = toString(node).trim();
      const id = uniqueId(headingSlug(title), used);
      const cue = String(parts.sections.length + 1).padStart(2, "0");
      node.properties = { ...node.properties, id };
      parts.sections.push({ id, title, cue, heading: node, children: [] });
      parts.toc.push({ id, text: title, cue, depth: 1 });
      sub = 0;
      continue;
    }
    if (node.type === "element" && node.tagName === "h3") {
      const title = toString(node).trim();
      const id = uniqueId(headingSlug(title), used);
      node.properties = { ...node.properties, id };
      // A subsection before any section is listed as a section of its own.
      if (section) parts.toc.push({ id, text: title, cue: `${section.cue}.${++sub}`, depth: 2 });
      else parts.toc.push({ id, text: title, cue: "00", depth: 1 });
    }
    if (section) section.children.push(node);
    else if (!parts.answer && !parts.intro.length && node.type === "element" && node.tagName === "p") parts.answer = node;
    else {
      // A picture before the first section sits near the top: fetched at once, not lazily.
      if (node.type === "element" && node.tagName === "img") node.properties = { ...node.properties, dataEager: "" };
      parts.intro.push(node);
    }
  }
  return parts;
}

/** The URL forms a link in a post may take, and where each one goes. */
export type LinkTarget = { kind: "internal"; href: string } | { kind: "external"; href: string } | { kind: "anchor"; href: string } | null;

/**
 * Classifies a link. `siteHosts` are this site's own hosts: an absolute link
 * to one of them is treated as internal (rendered as a site path).
 */
export function linkTarget(href: unknown, siteHosts: readonly string[]): LinkTarget {
  if (typeof href !== "string" || !href || href.length > 2000) return null;
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (href.startsWith("/") && !href.startsWith("//")) return { kind: "internal", href };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return { kind: "external", href: url.toString() };
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (siteHosts.includes(url.host.toLowerCase())) return { kind: "internal", href: `${url.pathname}${url.search}${url.hash}` };
  return { kind: "external", href: url.toString() };
}
