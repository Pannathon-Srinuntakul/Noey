import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogArticle } from "@/components/blog/BlogArticle";
import { BlogUnavailablePage } from "@/components/blog/BlogUnavailable";
import { BLOG_COPY, blogPostPath } from "@/lib/blog";
import { MISSING_METADATA, postMetadata } from "@/lib/blog-seo";
import { getBlogPost, getBlogSlugs, orUnavailable } from "@/lib/server/blog";
import { SITE_NAME, absoluteUrl } from "@/lib/site";

/*
 * One published post. Static and regenerated hourly (ISR), and at once when
 * the backend publishes, edits or takes it down (POST /api/revalidate-blog).
 *
 * Only a real 404 from the API (not published) is a 404 here. When the API
 * does not answer, the post renders from the last good answer this server
 * saw; a post it never saw shows the blog's "could not load" state, kept for
 * 30 s (lib/server/blog.ts) — never a 404 for a post that may exist.
 *
 * Proxy answers a slug that is not published with the site's 404 page before
 * this route runs (lib/blog-proxy.ts). The notFound() here is the backstop,
 * called before anything renders; metadata never throws, so a 404 can never
 * carry the post's canonical.
 */
export const revalidate = 3600;

type Params = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const slugs = await getBlogSlugs();
  // No answer while building: build anyway, every post then renders on its first visit.
  return slugs.ok ? slugs.data.map(({ slug }) => ({ slug })) : [];
}

/** The post; null when the API did not answer; `missing` when it is not published. */
async function load(params: Params["params"]) {
  const { slug } = await params;
  const result = await getBlogPost(slug);
  if (!result.ok) {
    orUnavailable(result, `post ${slug}`);
    return { slug, missing: false, post: null };
  }
  return result.data ? { slug, missing: false, post: result.data } : { slug, missing: true, post: null };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, missing, post } = await load(params);
  if (missing) return MISSING_METADATA;
  if (post) return postMetadata(post);
  return { title: { absolute: `${BLOG_COPY.unavailableTitle} | ${SITE_NAME}` }, alternates: { canonical: absoluteUrl(blogPostPath(slug)) } };
}

export default async function BlogPostPage({ params }: Params) {
  const { slug, missing, post } = await load(params);
  if (missing) notFound();
  return post ? <BlogArticle post={post} /> : <BlogUnavailablePage path={blogPostPath(slug)} />;
}
