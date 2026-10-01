import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogListing } from "@/components/blog/BlogListing";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, BLOG_PATH, firstPages, pageCount, parsePageParam } from "@/lib/blog";
import { BLOG_TRAIL, listingMetadata } from "@/lib/blog-seo";
import { getBlogCategories, getBlogPage, orUnavailable } from "@/lib/server/blog";
import { PAGES } from "@/lib/site";

/*
 * /blog and /blog?page=N. Visitors never see this path: next.config.ts
 * rewrites /blog to /blog/page/1 and /blog?page=N to /blog/page/N, and sends
 * a direct visit here back to the public URL. As a param route every page is
 * static and regenerated in the background (ISR) — and when a build cannot
 * reach the API, no page is prerendered without posts: the first visit
 * renders it instead.
 */
export const revalidate = 600;

type Params = { params: Promise<{ page: string }> };

export async function generateStaticParams() {
  const first = await getBlogPage({ page: 1 });
  return first.ok ? firstPages(first.data.total).map((page) => ({ page })) : [];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = parsePageParam((await params).page);
  if (!page) notFound();
  const list = orUnavailable(await getBlogPage({ page }), "blog listing");
  return listingMetadata({
    path: BLOG_PATH,
    title: BLOG_COPY.title,
    description: BLOG_COPY.description,
    page,
    last: list ? pageCount(list.total) : 1,
    indexable: true,
  });
}

export default async function BlogIndexPage({ params }: Params) {
  const page = parsePageParam((await params).page);
  if (!page) notFound();
  const [listResult, categoriesResult] = await Promise.all([getBlogPage({ page }), getBlogCategories()]);
  const list = orUnavailable(listResult, "blog listing");
  const categories = orUnavailable(categoriesResult, "blog categories");
  if (list && page > 1 && page > pageCount(list.total)) notFound();

  return (
    <BlogListing
      kind="all"
      path={BLOG_PATH}
      page={page}
      title={BLOG_COPY.h1}
      lead={
        <p>
          {keepThaiProse(BLOG_COPY.lead)} {keepThaiProse(BLOG_COPY.leadGuide)}{" "}
          <Link href={PAGES.guide.path} prefetch={false}>
            {PAGES.guide.label}
          </Link>
        </p>
      }
      trail={BLOG_TRAIL}
      list={list}
      categories={categories}
      current={null}
      jsonLdName={`${BLOG_COPY.title} | Noey Studio`}
      jsonLdDescription={BLOG_COPY.description}
    />
  );
}
