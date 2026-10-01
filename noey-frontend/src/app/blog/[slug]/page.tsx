import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogArticle } from "@/components/blog/BlogArticle";
import { postMetadata } from "@/lib/blog-seo";
import { BlogUnavailableError, getBlogPost, getBlogSlugs } from "@/lib/server/blog";

/*
 * One published post. Static and regenerated hourly (ISR), and at once when
 * the backend publishes, edits or takes it down (POST /api/revalidate-blog).
 *
 * When the API does not answer, the page THROWS — never a 404 and never an
 * empty page: ISR then keeps serving the last good copy, and a post that was
 * never rendered shows the blog's "try again" state (app/blog/error.tsx).
 * Only a real 404 from the API (not published) is a 404 here.
 */
export const revalidate = 3600;

type Params = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const slugs = await getBlogSlugs();
  // No answer while building: build anyway, every post then renders on its first visit.
  return slugs.ok ? slugs.data.map(({ slug }) => ({ slug })) : [];
}

async function load(params: Params["params"]) {
  const { slug } = await params;
  const result = await getBlogPost(slug);
  if (!result.ok) throw new BlogUnavailableError(`post ${slug}`);
  if (!result.data) notFound();
  return result.data;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return postMetadata(await load(params));
}

export default async function BlogPostPage({ params }: Params) {
  return <BlogArticle post={await load(params)} />;
}
