import type { Metadata } from "next";
import { LOCALE, PAGES, SITE_NAME, absoluteUrl, type PageKey } from "./site";

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
export const PAGES_WITH_OWN_OG_IMAGE: ReadonlySet<PageKey> = new Set<PageKey>(["home", "examples", "pricing", "about", "signup"]);

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
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
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
