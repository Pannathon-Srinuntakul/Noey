/**
 * Atom feed of every indexable page, newest content date first.
 *
 * It exists so search and answer engines have a change signal that is not the
 * sitemap: when a guide page's copy changes, its `updated` date moves in the
 * registry and this feed says so. Dates are CONTENT dates from `site.ts` — a
 * feed whose entries move on every rebuild is a fake freshness signal.
 */
import type { BlogPostSummary } from "./blog";
import { feedEntryLines, postFeedEntry, type FeedEntry } from "./blog-machine";
import { GUIDE_DOCS } from "./guide";
import { CONTENT_AUTHOR } from "./seo";
import { LANG, PAGES, SITE_NAME, SITE_URL, absoluteUrl, publishedDate, type PageKey } from "./site";

const FEED_PATH = "/feed.xml";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A calendar date as the RFC 3339 timestamp Atom requires (Bangkok midnight). */
function atomTimestamp(isoDate: string): string {
  return `${isoDate}T00:00:00+07:00`;
}

/** The entry's summary: the guide page's own answer, or its meta description. */
function summaryFor(key: PageKey): string {
  const doc = key in GUIDE_DOCS ? GUIDE_DOCS[key as keyof typeof GUIDE_DOCS] : null;
  return doc ? doc.answer : PAGES[key].description;
}

export function feedEntryKeys(): PageKey[] {
  return (Object.keys(PAGES) as PageKey[])
    .filter((key) => PAGES[key].indexable)
    .sort((a, b) => {
      const byDate = PAGES[b].updated.localeCompare(PAGES[a].updated);
      return byDate !== 0 ? byDate : PAGES[a].path.localeCompare(PAGES[b].path);
    });
}

function pageEntry(key: PageKey): FeedEntry {
  const page = PAGES[key];
  return {
    title: page.title,
    url: absoluteUrl(page.path),
    published: atomTimestamp(publishedDate(key)),
    updated: atomTimestamp(page.updated),
    summary: summaryFor(key),
  };
}

/**
 * Every indexable page and every blog post, newest content first. A post's
 * dates are its own publish/update times (full timestamps); a page's are its
 * registry dates at Bangkok midnight. `posts` is empty when the blog API did
 * not answer during a build (ISR fills it in afterwards).
 */
export function buildAtomFeed(posts: readonly BlogPostSummary[] = []): string {
  const entries = [...feedEntryKeys().map(pageEntry), ...posts.map(postFeedEntry)]
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.updated) }))
    // Newest first; on a tie the registry's own order (it already breaks ties by path).
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ entry }) => entry);
  const latest = entries.length > 0 ? entries[0].updated : atomTimestamp(PAGES.home.updated);
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${LANG}">`,
    `  <title>${escapeXml(SITE_NAME)}</title>`,
    `  <subtitle>${escapeXml(PAGES.home.description)}</subtitle>`,
    `  <id>${SITE_URL}/</id>`,
    `  <link rel="alternate" type="text/html" href="${absoluteUrl("/")}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${absoluteUrl(FEED_PATH)}"/>`,
    `  <updated>${latest}</updated>`,
    `  <author><name>${escapeXml(CONTENT_AUTHOR)}</name></author>`,
  ];
  for (const entry of entries) lines.push(...feedEntryLines(entry));
  lines.push("</feed>");
  return `${lines.join("\n")}\n`;
}
