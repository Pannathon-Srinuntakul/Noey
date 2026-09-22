import type { MetadataRoute } from "next";

/** Nothing here is for search engines or AI crawlers. No sitemap exists. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
