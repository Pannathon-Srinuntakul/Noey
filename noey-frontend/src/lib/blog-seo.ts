/**
 * Metadata and JSON-LD for the blog pages. Pure (unit-tested): the pages
 * pass in what they fetched. Same rules as lib/seo.ts — the full OG/Twitter
 * set on every page (Next merges metadata shallowly), absolute canonicals,
 * and structured data that only describes what the page shows.
 */
import type { Metadata } from "next";
import {
  BLOG_COPY,
  BLOG_FEED_PATH,
  BLOG_PATH,
  blogMarkdownPath,
  blogPostPath,
  withPage,
  type BlogPost,
  type BlogPostSummary,
} from "./blog";
import {
  blogNode,
  blogPostingNode,
  breadcrumbNode,
  faqPageNode,
  itemListNode,
  jsonLdGraph,
  organizationNode,
  webPageNode,
  type Crumb,
  type JsonLdImage,
  type JsonLdNode,
} from "./jsonld";
import { LOCALE, PAGES, SITE_NAME, absoluteUrl } from "./site";

export const BLOG_ID = `${absoluteUrl(BLOG_PATH)}#blog`;

/** The share image of the listing pages (app/blog/opengraph-image.tsx). */
export const BLOG_SHARE_IMAGE = { url: "/blog/opengraph-image", width: 1200, height: 630, alt: BLOG_COPY.h1 };

/** The generated share image of a post without a cover (app/blog/[slug]/opengraph-image.tsx). */
export function postShareImagePath(slug: string): string {
  return `${blogPostPath(slug)}/opengraph-image`;
}

const FEED_TYPES = { "application/atom+xml": [{ url: BLOG_FEED_PATH, title: BLOG_COPY.feedTitle }] };

const INDEXABLE: Metadata["robots"] = {
  index: true,
  follow: true,
  googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
};

export const BLOG_TRAIL: readonly Crumb[] = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: BLOG_COPY.label, path: BLOG_PATH },
];

export interface ListingMeta {
  /** The listing's canonical base path: /blog, /blog/category/x, /blog/tag/x. */
  path: string;
  /** Without the brand; " | Noey Studio" is added. */
  title: string;
  description: string;
  page: number;
  last: number;
  indexable: boolean;
}

/** A listing page: self-canonical per page (`?page=N`), prev/next, the blog feed. */
export function listingMetadata(input: ListingMeta): Metadata {
  const suffix = input.page > 1 ? ` · ${BLOG_COPY.page(input.page)}` : "";
  const title = `${input.title}${suffix} | ${SITE_NAME}`;
  const url = absoluteUrl(withPage(input.path, input.page));
  return {
    title: { absolute: title },
    description: input.description,
    alternates: { canonical: url, types: FEED_TYPES },
    pagination: {
      previous: input.page > 1 ? absoluteUrl(withPage(input.path, input.page - 1)) : undefined,
      next: input.page < input.last ? absoluteUrl(withPage(input.path, input.page + 1)) : undefined,
    },
    openGraph: { type: "website", siteName: SITE_NAME, locale: LOCALE, url, title, description: input.description, images: [BLOG_SHARE_IMAGE] },
    twitter: { card: "summary_large_image", title, description: input.description, images: [BLOG_SHARE_IMAGE] },
    robots: input.indexable ? INDEXABLE : { index: false, follow: true },
  };
}

/** The title a post's <title> uses: its meta_title, brand appended once. */
export function postTitle(post: Pick<BlogPostSummary, "metaTitle" | "title">): string {
  const base = (post.metaTitle || post.title).trim();
  return /\|\s*Noey Studio\s*$/i.test(base) ? base : `${base} | ${SITE_NAME}`;
}

/** A post page: article OG tags, its cover or its generated image, the Markdown twin and the feed. */
export function postMetadata(post: BlogPost): Metadata {
  const url = absoluteUrl(blogPostPath(post.slug));
  const title = postTitle(post);
  const description = post.metaDescription || post.excerpt;
  // With a cover the cover is the share image; without one the segment's own
  // opengraph-image file applies — and a page that sets `images` overrides it.
  const images = post.cover ? { images: [{ url: post.cover.url, width: post.cover.width ?? undefined, height: post.cover.height ?? undefined, alt: post.cover.alt || post.title }] } : {};
  return {
    title: { absolute: title },
    description,
    authors: [{ name: SITE_NAME }],
    alternates: { canonical: url, types: { ...FEED_TYPES, "text/markdown": blogMarkdownPath(post.slug) } },
    other: { date: post.publishedAt, "last-modified": post.updatedAt },
    openGraph: {
      type: "article",
      siteName: SITE_NAME,
      locale: LOCALE,
      url,
      title,
      description,
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      section: post.category.name,
      tags: post.tags.map((tag) => tag.name),
      authors: [SITE_NAME],
      ...images,
    },
    twitter: { card: "summary_large_image", title, description, ...images },
    robots: INDEXABLE,
  };
}

function postImage(post: BlogPostSummary): JsonLdImage {
  return post.cover
    ? { url: post.cover.url, width: post.cover.width, height: post.cover.height }
    : { url: absoluteUrl(postShareImagePath(post.slug)), width: 1200, height: 630 };
}

/** JSON-LD of a post: WebPage + BlogPosting (+ FAQPage) + BreadcrumbList + the Organization they name. */
export function postJsonLd(post: BlogPost, trail: readonly Crumb[]): JsonLdNode {
  const path = blogPostPath(post.slug);
  const description = post.metaDescription || post.excerpt;
  return jsonLdGraph(
    organizationNode(),
    webPageNode({ path, name: post.title, description, dateModified: post.updatedAt }),
    blogPostingNode({
      path,
      headline: post.title,
      description,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      image: postImage(post),
      section: post.category.name,
      keywords: post.tags.map((tag) => tag.name),
      blogId: BLOG_ID,
    }),
    ...(post.faq.length ? [faqPageNode(post.faq, path)] : []),
    breadcrumbNode(trail),
  );
}

/** JSON-LD of a listing: CollectionPage + ItemList + BreadcrumbList; the blog index adds the Blog itself. */
export function listingJsonLd(input: {
  path: string;
  page: number;
  name: string;
  description: string;
  posts: readonly BlogPostSummary[];
  trail: readonly Crumb[];
  isBlogIndex: boolean;
}): JsonLdNode {
  const path = withPage(input.path, input.page);
  const items = input.posts.map((post) => ({ name: post.title, path: blogPostPath(post.slug) }));
  return jsonLdGraph(
    organizationNode(),
    webPageNode({
      path,
      name: input.name,
      description: input.description,
      dateModified: input.posts.reduce((latest, post) => (post.updatedAt > latest ? post.updatedAt : latest), input.posts[0]?.updatedAt ?? ""),
      type: "CollectionPage",
    }),
    ...(input.isBlogIndex
      ? [
          blogNode({
            path: BLOG_PATH,
            name: `${BLOG_COPY.label} · ${SITE_NAME}`,
            description: BLOG_COPY.description,
            posts: input.posts.map((post) => ({
              path: blogPostPath(post.slug),
              headline: post.title,
              datePublished: post.publishedAt,
              dateModified: post.updatedAt,
              image: postImage(post),
            })),
          }),
        ]
      : []),
    ...(items.length ? [itemListNode({ path, name: input.name, items })] : []),
    breadcrumbNode(input.trail),
  );
}
