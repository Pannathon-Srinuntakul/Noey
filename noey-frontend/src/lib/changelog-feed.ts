/**
 * Atom feed of /changelog: one entry per change, newest first. Ids are the
 * page URL plus the entry's anchor, so a reader can open the exact entry.
 * Dates are the entries' own dates, never the build time.
 */
import { CHANGELOG, CHANGELOG_UPDATED, CHANGE_KIND_LABEL } from "./changelog";
import { LANG, PAGES, SITE_NAME, absoluteUrl } from "./site";

export const CHANGELOG_FEED_PATH = "/changelog/feed.xml";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const atomTimestamp = (isoDate: string) => `${isoDate}T00:00:00+07:00`;

export function buildChangelogFeed(): string {
  const page = absoluteUrl(PAGES.changelog.path);
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${LANG}">`,
    `  <title>${escapeXml(`${PAGES.changelog.label} · ${SITE_NAME}`)}</title>`,
    `  <subtitle>${escapeXml(PAGES.changelog.description)}</subtitle>`,
    `  <id>${page}</id>`,
    `  <link rel="alternate" type="text/html" href="${page}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${absoluteUrl(CHANGELOG_FEED_PATH)}"/>`,
    `  <updated>${atomTimestamp(CHANGELOG_UPDATED)}</updated>`,
    `  <author><name>${escapeXml(SITE_NAME)}</name></author>`,
  ];
  for (const entry of CHANGELOG) {
    const url = `${page}#${entry.id}`;
    lines.push(
      "  <entry>",
      `    <title>${escapeXml(`${CHANGE_KIND_LABEL[entry.kind]}: ${entry.title}`)}</title>`,
      `    <id>${url}</id>`,
      `    <link rel="alternate" type="text/html" href="${url}"/>`,
      `    <published>${atomTimestamp(entry.date)}</published>`,
      `    <updated>${atomTimestamp(entry.date)}</updated>`,
      `    <summary type="text">${escapeXml([...entry.body, entry.plans ?? ""].filter(Boolean).join(" "))}</summary>`,
      "  </entry>",
    );
  }
  lines.push("</feed>");
  return `${lines.join("\n")}\n`;
}
