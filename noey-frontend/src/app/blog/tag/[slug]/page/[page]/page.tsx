import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogListing } from "@/components/blog/BlogListing";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, TAG_INDEX_MIN_POSTS, firstPages, isBlogSlug, pageCount, parsePageParam, tagPath } from "@/lib/blog";
import { BLOG_TRAIL, MISSING_METADATA, listingMetadata } from "@/lib/blog-seo";
import { getBlogCategories, getBlogPage, getBlogTags, orUnavailable } from "@/lib/server/blog";

/*
 * /blog/tag/<slug> and its ?page=N, rewritten here by next.config.ts (see
 * app/blog/page/[page]/page.tsx). Only tags with a published post exist
 * (GET /blog/tags lists no others); a tag with fewer than three posts is
 * `noindex` — a thin page — though still a page a visitor can open.
 * Proxy answers a 404 before this route runs (lib/blog-proxy.ts); the checks
 * here are the backstop, and metadata never throws, so a 404 can never carry
 * a canonical.
 */
export const revalidate = 600;

type Params = { params: Promise<{ slug: string; page: string }> };

export async function generateStaticParams() {
  const tags = await getBlogTags();
  if (!tags.ok) return [];
  return tags.data.slice(0, 100).flatMap((tag) => firstPages(tag.postCount, 1).map((page) => ({ slug: tag.slug, page })));
}

async function load(params: Params["params"]) {
  const { slug, page: raw } = await params;
  const page = parsePageParam(raw);
  if (!page || !isBlogSlug(slug)) return { missing: true as const };
  const [tagsResult, listResult, categoriesResult] = await Promise.all([getBlogTags(), getBlogPage({ tag: slug, page }), getBlogCategories()]);
  const tags = orUnavailable(tagsResult, "blog tags");
  const list = orUnavailable(listResult, "tag listing");
  const categories = orUnavailable(categoriesResult, "blog categories");
  const tag = tags?.find((item) => item.slug === slug) ?? null;
  if (tags && !tag) return { missing: true as const };
  if (list && page > 1 && page > pageCount(list.total)) return { missing: true as const };
  return { missing: false as const, slug, page, list, tag, categories };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const loaded = await load(params);
  if (loaded.missing) return MISSING_METADATA;
  const { slug, page, list, tag } = loaded;
  return listingMetadata({
    path: tagPath(slug),
    // Unknown only while the API is down: the blog's own name, not a slug.
    title: tag ? BLOG_COPY.tagTitle(tag.name) : BLOG_COPY.title,
    description: tag ? BLOG_COPY.tagLead(tag.name) : BLOG_COPY.description,
    page,
    last: list ? pageCount(list.total) : 1,
    // Unknown while the API is down: a 30-second stand-in must not tell crawlers to drop it.
    indexable: list === null || list.total >= TAG_INDEX_MIN_POSTS,
  });
}

export default async function TagPage({ params }: Params) {
  const loaded = await load(params);
  if (loaded.missing) notFound();
  const { slug, page, list, tag, categories } = loaded;
  const title = tag ? BLOG_COPY.tagTitle(tag.name) : BLOG_COPY.h1;
  return (
    <BlogListing
      kind="tag"
      path={tagPath(slug)}
      page={page}
      title={title}
      lead={<p>{keepThaiProse(tag ? BLOG_COPY.tagLead(tag.name) : BLOG_COPY.lead)}</p>}
      trail={tag ? [...BLOG_TRAIL, { name: `${BLOG_COPY.tagsLabel} ${tag.name}`, path: tagPath(slug) }] : BLOG_TRAIL}
      list={list}
      categories={categories}
      current={undefined}
      jsonLdName={title}
      jsonLdDescription={tag ? BLOG_COPY.tagLead(tag.name) : BLOG_COPY.description}
    />
  );
}
