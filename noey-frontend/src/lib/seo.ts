import type { Metadata } from "next";
import { LOCALE, PAGES, SITE_NAME, absoluteUrl, publishedDate, type PageKey } from "./site";

/**
 * Pages are written and maintained by the team, not by a named individual —
 * so attribution names the team. Emitted as <meta name="author">, which is
 * what answer engines read for attribution.
 */
export const CONTENT_AUTHOR = `ทีมงาน ${SITE_NAME}`;

/** Guide/help pages are articles; everything else is a marketing page. */
function isArticle(key: PageKey): boolean {
  return PAGES[key].path === "/guide" || PAGES[key].path.startsWith("/guide/");
}

export interface MetadataOverrides {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  twitterTitle?: string;
  twitterDescription?: string;
}

/**
 * Pages whose route segment has its own generated `opengraph-image` (kept in
 * step with the files by a unit test). Every other page gets the site-wide
 * image explicitly: its `openGraph` object would otherwise replace the root
 * image with none. The explicit image must NOT be set on these pages — an
 * `openGraph.images` value in page metadata overrides the segment's file.
 */
export const PAGES_WITH_OWN_OG_IMAGE: ReadonlySet<PageKey> = new Set<PageKey>(["home", "scope", "pricing", "about", "signup"]);

const DEFAULT_SHARE_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: "Noey Studio ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์" };

const INDEXABLE_ROBOTS: Metadata["robots"] = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-image-preview": "large",
    "max-snippet": -1,
    "max-video-preview": -1,
  },
};

/**
 * Complete metadata for a registry page. Next.js merges metadata SHALLOWLY, so
 * a page that sets `openGraph` replaces the layout's whole object — which is
 * why this helper always returns the full OG/Twitter set rather than relying
 * on inheritance. og:image comes from the route's `opengraph-image` file.
 */
export function pageMetadata(key: PageKey, overrides: MetadataOverrides = {}): Metadata {
  const page = PAGES[key];
  const title = overrides.title ?? page.title;
  const description = overrides.description ?? page.description;
  const url = absoluteUrl(page.path);
  const images = PAGES_WITH_OWN_OG_IMAGE.has(key) ? {} : { images: [DEFAULT_SHARE_IMAGE] };
  const published = publishedDate(key);
  // Dates come from the ONE registry entry, so the visible "อัปเดตล่าสุด"
  // line, the sitemap, JSON-LD and these tags can never disagree. The `date`
  // and `last-modified` names are the pair generic crawlers read; guide pages
  // additionally carry the og article:* properties.
  const article = isArticle(key)
    ? ({ type: "article", publishedTime: published, modifiedTime: page.updated, authors: [CONTENT_AUTHOR] } as const)
    : ({ type: "website" } as const);
  return {
    title: { absolute: title },
    description,
    authors: [{ name: CONTENT_AUTHOR }],
    alternates: { canonical: url },
    other: { date: published, "last-modified": page.updated },
    openGraph: {
      ...article,
      siteName: SITE_NAME,
      locale: LOCALE,
      url,
      title: overrides.ogTitle ?? title,
      description: overrides.ogDescription ?? description,
      ...images,
    },
    twitter: {
      card: "summary_large_image",
      title: overrides.twitterTitle ?? overrides.ogTitle ?? title,
      description: overrides.twitterDescription ?? overrides.ogDescription ?? description,
      ...images,
    },
    robots: page.indexable ? INDEXABLE_ROBOTS : { index: false, follow: true },
  };
}

/**
 * Point agents at a page's Markdown twin (`/scope` -> `/scope.md`). Kept as a
 * helper so the metadata and the `Link: rel="alternate"` response header in
 * next.config.ts stay in step.
 */
export function withMarkdownTwin(metadata: Metadata, markdownPath: string): Metadata {
  return { ...metadata, alternates: { ...metadata.alternates, types: { "text/markdown": markdownPath } } };
}

/** `/guide/help` -> `/guide/help.md`. */
export function markdownTwinPath(key: PageKey): string {
  return `${PAGES[key].path}.md`;
}

/**
 * Pages opened from an emailed one-time token (/reset-password,
 * /verify-email): never indexed, and the token in the URL is never sent on as
 * a Referer (the `no-referrer` response header is set in next.config.ts too).
 */
export function tokenPageMetadata(title: string): Metadata {
  return {
    title: { absolute: `${title} | ${SITE_NAME}` },
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

/** Signed-in pages: never indexed, no canonical, no social card. */
export function privatePageMetadata(title: string): Metadata {
  return {
    title: { absolute: `${title} | ${SITE_NAME}` },
    robots: { index: false, follow: false, nocache: true },
  };
}
