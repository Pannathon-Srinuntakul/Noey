import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogListing } from "@/components/blog/BlogListing";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, categoryPath, firstPages, isBlogSlug, pageCount, parsePageParam } from "@/lib/blog";
import { BLOG_TRAIL, MISSING_METADATA, listingMetadata } from "@/lib/blog-seo";
import { getBlogCategories, getBlogPage, orUnavailable } from "@/lib/server/blog";

/*
 * /blog/category/<slug> and its ?page=N, rewritten here by next.config.ts
 * (see app/blog/page/[page]/page.tsx). A real page per category, not a
 * filter in the browser. The categories are the backend's fixed set: an
 * unknown slug is a 404, a known one without posts yet is the empty state.
 * Proxy answers a 404 before this route runs (lib/blog-proxy.ts); the checks
 * here are the backstop, and metadata never throws, so a 404 can never carry
 * a canonical.
 */
export const revalidate = 600;

type Params = { params: Promise<{ slug: string; page: string }> };

export async function generateStaticParams() {
  const categories = await getBlogCategories();
  if (!categories.ok) return [];
  return categories.data.flatMap((category) => firstPages(category.postCount, 3).map((page) => ({ slug: category.slug, page })));
}

async function load(params: Params["params"]) {
  const { slug, page: raw } = await params;
  const page = parsePageParam(raw);
  if (!page || !isBlogSlug(slug)) return { missing: true as const };
  const [categoriesResult, listResult] = await Promise.all([getBlogCategories(), getBlogPage({ category: slug, page })]);
  const categories = orUnavailable(categoriesResult, "blog categories");
  const list = orUnavailable(listResult, "category listing");
  const category = categories?.find((item) => item.slug === slug) ?? null;
  if (categories && !category) return { missing: true as const };
  if (list && page > 1 && page > pageCount(list.total)) return { missing: true as const };
  return { missing: false as const, slug, page, categories, list, category };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const loaded = await load(params);
  if (loaded.missing) return MISSING_METADATA;
  const { slug, page, list, category } = loaded;
  return listingMetadata({
    path: categoryPath(slug),
    // Unknown only while the API is down: the blog's own name, not a slug.
    title: category ? BLOG_COPY.categoryTitle(category.name) : BLOG_COPY.title,
    description: category?.description || BLOG_COPY.description,
    page,
    last: list ? pageCount(list.total) : 1,
    // An empty category is not a page worth indexing yet. (Unknown while the
    // API is down: a 30-second stand-in must not tell crawlers to drop it.)
    indexable: list === null || list.total > 0,
  });
}

export default async function CategoryPage({ params }: Params) {
  const loaded = await load(params);
  if (loaded.missing) notFound();
  const { slug, page, list, categories, category } = loaded;
  const title = category ? BLOG_COPY.categoryTitle(category.name) : BLOG_COPY.h1;
  return (
    <BlogListing
      kind="category"
      path={categoryPath(slug)}
      page={page}
      title={title}
      lead={<p>{keepThaiProse(category?.description || BLOG_COPY.lead)}</p>}
      trail={category ? [...BLOG_TRAIL, { name: category.name, path: categoryPath(slug) }] : BLOG_TRAIL}
      list={list}
      categories={categories}
      current={slug}
      jsonLdName={title}
      jsonLdDescription={category?.description || BLOG_COPY.description}
    />
  );
}
