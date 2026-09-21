import type { MetadataRoute } from "next";
import { PAGES, absoluteUrl } from "@/lib/site";

/**
 * Indexable, canonical pages only (login, account, checkout and the draft
 * legal pages are noindex and stay out). `lastModified` is each page's
 * content date from the registry — not the build time, which would claim a
 * change on every deploy. changefreq/priority are omitted: Google ignores them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return Object.values(PAGES)
    .filter((page) => page.indexable)
    .map((page) => ({
      url: absoluteUrl(page.path),
      lastModified: page.updated,
    }));
}
