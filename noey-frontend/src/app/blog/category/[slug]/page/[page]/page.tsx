import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogListing } from "@/components/blog/BlogListing";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, categoryPath, firstPages, isBlogSlug, pageCount, parsePageParam } from "@/lib/blog";
import { BLOG_TRAIL, listingMetadata } from "@/lib/blog-seo";
import { getBlogCategories, getBlogPage, orUnavailable } from "@/lib/server/blog";

/*
 * /blog/category/<slug> and its ?page=N, rewritten here by next.config.ts
 * (see app/blog/page/[page]/page.tsx). A real page per category, not a
 * filter in the browser. The categories are the backend's fixed set: an
 * unknown slug is a 404, a known one without posts yet is the empty state.
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
  if (!page || !isBlogSlug(slug)) notFound();
  const [categoriesResult, listResult] = await Promise.all([getBlogCategories(), getBlogPage({ category: slug, page })]);
  const categories = orUnavailable(categoriesResult, "blog categories");
  const list = orUnavailable(listResult, "category listing");
  const category = categories?.find((item) => item.slug === slug) ?? null;
  if (categories && !category) notFound();
  if (list && page > 1 && page > pageCount(list.total)) notFound();
  return { slug, page, categories, list, category };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, page, list, category } = await load(params);
  const name = category?.name ?? slug;
  return listingMetadata({
    path: categoryPath(slug),
    title: BLOG_COPY.categoryTitle(name),
    description: category?.description || BLOG_COPY.description,
    page,
    last: list ? pageCount(list.total) : 1,
    // An empty category is not a page worth indexing yet.
    indexable: !!list && list.total > 0,
  });
}

export default async function CategoryPage({ params }: Params) {
  const { slug, page, list, categories, category } = await load(params);
  const name = category?.name ?? slug;
  const title = BLOG_COPY.categoryTitle(name);
  return (
    <BlogListing
      kind="category"
      path={categoryPath(slug)}
      page={page}
      title={title}
      lead={category?.description ? <p>{keepThaiProse(category.description)}</p> : null}
      trail={[...BLOG_TRAIL, { name, path: categoryPath(slug) }]}
      list={list}
      categories={categories}
      current={slug}
      jsonLdName={title}
      jsonLdDescription={category?.description || BLOG_COPY.description}
    />
  );
}
