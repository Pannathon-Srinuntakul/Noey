/**
 * The blog's machine-readable surfaces, built from the same mapped posts the
 * pages render: a post's Markdown twin (/blog/<slug>.md), the blog's Atom
 * feed (/blog/feed.xml), its entries in the site feed (/feed.xml) and its
 * section of /llms.txt. Pure (unit-tested). Dates are the posts' own
 * publish/update times from the API — never the build time.
 */
import {
  BLOG_COPY,
  BLOG_FEED_PATH,
  BLOG_LAUNCH_DATE,
  BLOG_PATH,
  blogMarkdownPath,
  blogPostPath,
  categoryPath,
  tagPath,
  type BlogPost,
  type BlogPostSummary,
} from "./blog";
import { LANG, SITE_NAME, SITE_URL, absoluteUrl } from "./site";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** An Atom entry the site feed (/feed.xml) mixes in with its pages. */
export interface FeedEntry {
  title: string;
  url: string;
  /** RFC 3339 timestamps. */
  published: string;
  updated: string;
  summary: string;
  category?: { term: string; label: string };
}

export function postFeedEntry(post: BlogPostSummary): FeedEntry {
  return {
    title: post.title,
    url: absoluteUrl(blogPostPath(post.slug)),
    published: post.publishedAt,
    updated: post.updatedAt,
    summary: post.excerpt || post.metaDescription,
    category: { term: post.category.slug, label: post.category.name },
  };
}

export function feedEntryLines(entry: FeedEntry): string[] {
  return [
    "  <entry>",
    `    <title>${escapeXml(entry.title)}</title>`,
    `    <id>${escapeXml(entry.url)}</id>`,
    `    <link rel="alternate" type="text/html" href="${escapeXml(entry.url)}"/>`,
    `    <published>${entry.published}</published>`,
    `    <updated>${entry.updated}</updated>`,
    ...(entry.category ? [`    <category term="${escapeXml(entry.category.term)}" label="${escapeXml(entry.category.label)}"/>`] : []),
    `    <summary type="text">${escapeXml(entry.summary)}</summary>`,
    "  </entry>",
  ];
}

/** /blog/feed.xml — the posts only, newest first. */
export function buildBlogFeed(posts: readonly BlogPostSummary[]): string {
  const page = absoluteUrl(BLOG_PATH);
  // The feed changes when a post does; with no post yet it dates from the blog's launch.
  const updated = posts.reduce((latest, post) => (post.updatedAt > latest ? post.updatedAt : latest), "");
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${LANG}">`,
    `  <title>${escapeXml(BLOG_COPY.feedTitle)}</title>`,
    `  <subtitle>${escapeXml(BLOG_COPY.description)}</subtitle>`,
    `  <id>${page}</id>`,
    `  <link rel="alternate" type="text/html" href="${page}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${absoluteUrl(BLOG_FEED_PATH)}"/>`,
    `  <updated>${updated || `${BLOG_LAUNCH_DATE}T00:00:00+07:00`}</updated>`,
    `  <author><name>${escapeXml(SITE_NAME)}</name><uri>${SITE_URL}/</uri></author>`,
  ];
  for (const post of posts) lines.push(...feedEntryLines(postFeedEntry(post)));
  lines.push("</feed>");
  return `${lines.join("\n")}\n`;
}

/** Site-relative Markdown links and images → absolute, so the twin reads the same anywhere. */
export function absolutizeMarkdownLinks(markdown: string): string {
  return markdown.replace(/(\]\()(\/(?!\/)[^)\s]*)/g, (_, open: string, path: string) => `${open}${absoluteUrl(path)}`);
}

/**
 * A `::visual[alt](id)` line is HTML drawn in the page, not something a
 * Markdown reader can show: the twin says what it pictures instead.
 */
export function describeVisuals(markdown: string): string {
  return markdown.replace(/^ {0,3}::visual\[([^\]\n]*)\]\([0-9a-f]{32}\)[ \t]*$/gm, (_, alt: string) => `*[ภาพประกอบ: ${alt.trim() || "ภาพ"}]*`);
}

const date = (iso: string) => iso.slice(0, 10);

/** /blog/<slug>.md — the post as its page shows it: header, answer, body, FAQ, related reading. */
export function buildPostMarkdown(post: BlogPost): string {
  const lines = [
    `# ${post.title}`,
    "",
    `- หน้าเว็บ: ${absoluteUrl(blogPostPath(post.slug))}`,
    `- เผยแพร่: ${date(post.publishedAt)} · อัปเดตล่าสุด: ${date(post.updatedAt)}`,
    `- ผู้เขียน: ${SITE_NAME}`,
    `- หมวด: [${post.category.name}](${absoluteUrl(categoryPath(post.category.slug))})`,
    ...(post.tags.length ? [`- แท็ก: ${post.tags.map((tag) => tag.name).join(", ")}`] : []),
    `- เวลาอ่าน: ${post.readingMinutes} นาที`,
    "",
    ...(post.excerpt ? [`> ${post.excerpt}`, ""] : []),
    absolutizeMarkdownLinks(describeVisuals(post.contentMd.trim())),
    "",
  ];
  if (post.faq.length) {
    lines.push("## คำถามที่พบบ่อย", "");
    for (const item of post.faq) lines.push(`### ${item.question}`, "", item.answer, "");
  }
  if (post.related.length) {
    lines.push("## บทความที่เกี่ยวข้อง", "");
    for (const item of post.related) lines.push(`- [${item.title}](${absoluteUrl(blogPostPath(item.slug))}): ${item.excerpt}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The posts in /llms.txt: each with its excerpt and its Markdown twin. */
export function llmsBlogLines(posts: readonly BlogPostSummary[]): string[] {
  if (!posts.length) return [];
  return [
    "## บทความล่าสุด",
    "",
    ...posts.map(
      (post) =>
        `- [${post.title}](${absoluteUrl(blogPostPath(post.slug))}): ${post.excerpt || post.metaDescription} · Markdown: ${absoluteUrl(blogMarkdownPath(post.slug))}`,
    ),
    "",
  ];
}

export interface SitemapEntry {
  url: string;
  lastModified?: string;
}

/**
 * The blog's sitemap entries: /blog (dated by its newest post), each listing
 * that has posts (dated by its first page), and every published post (its
 * own `updated_at`). Nothing when there is no post: an empty blog is not a
 * page to submit.
 */
export function blogSitemapEntries(input: {
  slugs: readonly { slug: string; updatedAt: string }[];
  categories: readonly { slug: string; lastModified: string }[];
  tags: readonly { slug: string; lastModified: string }[];
}): SitemapEntry[] {
  if (!input.slugs.length) return [];
  const index = input.slugs.reduce((latest, slug) => (slug.updatedAt > latest ? slug.updatedAt : latest), "");
  return [
    { url: absoluteUrl(BLOG_PATH), lastModified: index },
    ...input.categories.map((category) => ({ url: absoluteUrl(categoryPath(category.slug)), lastModified: category.lastModified || undefined })),
    ...input.tags.map((tag) => ({ url: absoluteUrl(tagPath(tag.slug)), lastModified: tag.lastModified || undefined })),
    ...input.slugs.map((slug) => ({ url: absoluteUrl(blogPostPath(slug.slug)), lastModified: slug.updatedAt })),
  ];
}
