import { notFound } from "next/navigation";
import { BLOG_COPY } from "@/lib/blog";
import { getBlogPost, BlogUnavailableError } from "@/lib/server/blog";
import { renderOgCard } from "@/lib/server/og";
import { OgText, ogTextBlock } from "@/lib/server/og-text";
import { BRAND } from "@/lib/site";

/*
 * The share image of a post without a cover (a post with one shares its
 * cover: lib/blog-seo.ts sets og:image, which overrides this file). The
 * site's share card with the post's category and title — drawn as outlines
 * so every Thai tone mark sits where it should (lib/server/og-text.tsx).
 */
export const alt = `${BLOG_COPY.label} · Noey Studio`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Drawn on its first request, then cached and refreshed like the post (tags
// `blog`, `blog:<slug>`), not drawn again for every crawler that asks.
export const dynamic = "force-static";
export const revalidate = 3600;

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getBlogPost(slug);
  if (!result.ok) throw new BlogUnavailableError(`post ${slug} (share image)`);
  const post = result.data;
  if (!post) notFound();
  const eyebrow = ogTextBlock(`${BLOG_COPY.label} · ${post.category.name}`, { sizes: [26], maxWidth: 1040, maxLines: 1 });
  const title = ogTextBlock(post.title, { sizes: [62, 56, 50, 44], maxWidth: 1040, maxLines: 3, lineHeight: 1.38 });
  return renderOgCard({
    eyebrow: (
      <div style={{ display: "flex", marginBottom: 6 }}>
        <OgText block={eyebrow} color={BRAND.gold} />
      </div>
    ),
    title: (
      <div style={{ display: "flex" }}>
        <OgText block={title} color={BRAND.offWhite} />
      </div>
    ),
  });
}
