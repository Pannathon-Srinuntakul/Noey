import type { MetadataRoute } from "next";
import { TAG_INDEX_MIN_POSTS } from "@/lib/blog";
import { blogSitemapEntries } from "@/lib/blog-machine";
import { getBlogCategories, getBlogPage, getBlogSlugs, getBlogTags, orUnavailable } from "@/lib/server/blog";
import { PAGES, absoluteUrl } from "@/lib/site";

// The blog's part changes with the posts: refreshed with the listings and on
// every publish (POST /api/revalidate-blog revalidates /sitemap.xml).
export const revalidate = 600;

const newest = (dates: readonly string[]) => dates.reduce((latest, value) => (value > latest ? value : latest), "");

/** The blog's indexable pages, fetched; [] while a build cannot reach the API (ISR adds them). */
async function blogEntries(): Promise<MetadataRoute.Sitemap> {
  const [slugsResult, categoriesResult, tagsResult] = await Promise.all([getBlogSlugs(), getBlogCategories(), getBlogTags()]);
  const slugs = orUnavailable(slugsResult, "sitemap: blog slugs");
  if (!slugs) return [];
  const categories = (orUnavailable(categoriesResult, "sitemap: blog categories") ?? []).filter((category) => category.postCount > 0);
  const tags = (orUnavailable(tagsResult, "sitemap: blog tags") ?? []).filter((tag) => tag.postCount >= TAG_INDEX_MIN_POSTS).slice(0, 100);
  // A listing changed when a post on its first page did.
  const listingDate = async (query: { category?: string; tag?: string }) => {
    const first = orUnavailable(await getBlogPage({ page: 1, ...query }), "sitemap: blog listing");
    return newest(first?.items.map((post) => post.updatedAt) ?? []);
  };
  const [categoryDates, tagDates] = await Promise.all([
    Promise.all(categories.map((category) => listingDate({ category: category.slug }))),
    Promise.all(tags.map((tag) => listingDate({ tag: tag.slug }))),
  ]);
  return blogSitemapEntries({
    slugs,
    categories: categories.map((category, at) => ({ slug: category.slug, lastModified: categoryDates[at] })),
    tags: tags.map((tag, at) => ({ slug: tag.slug, lastModified: tagDates[at] })),
  });
}

/**
 * Indexable, canonical pages only (login, account, checkout and the draft
 * legal pages are noindex and stay out). `lastModified` is each page's
 * content date from the registry — not the build time, which would claim a
 * change on every deploy — and each blog post's own `updated_at`.
 * changefreq/priority are omitted: Google ignores them.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = Object.values(PAGES)
    .filter((page) => page.indexable)
    .map((page) => ({
      url: absoluteUrl(page.path),
      lastModified: page.updated,
    }));
  return [...pages, ...(await blogEntries())];
}
