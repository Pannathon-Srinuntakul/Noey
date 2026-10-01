import { blogPostPath } from "@/lib/blog";
import { buildPostMarkdown } from "@/lib/blog-machine";
import { BlogUnavailableError, getBlogPost, getBlogSlugs } from "@/lib/server/blog";
import { absoluteUrl } from "@/lib/site";

/*
 * /blog/<slug>.md — the post's Markdown twin (rewritten here by
 * next.config.ts; a dynamic segment cannot end in ".md"). Same cache as the
 * HTML page and the same tags, so a publish, edit or take-down refreshes
 * both. The HTML page is the canonical document.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export async function generateStaticParams() {
  const slugs = await getBlogSlugs();
  return slugs.ok ? slugs.data.map(({ slug }) => ({ slug })) : [];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getBlogPost(slug);
  // Down: throw, so the last good copy keeps being served.
  if (!result.ok) throw new BlogUnavailableError(`post ${slug} (markdown)`);
  if (!result.data) {
    return new Response("ไม่พบบทความนี้\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(buildPostMarkdown(result.data), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${absoluteUrl(blogPostPath(slug))}>; rel="canonical"`,
    },
  });
}
