import { blogPostPath } from "@/lib/blog";
import { buildPostMarkdown } from "@/lib/blog-machine";
import { getBlogPost, getBlogSlugs, orUnavailable } from "@/lib/server/blog";
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
  // Down, and no earlier answer to use (lib/server/blog.ts): say so, briefly cached.
  if (!result.ok) {
    orUnavailable(result, `post ${slug} (markdown)`);
    return new Response("ตอนนี้ยังโหลดบทความไม่ได้ ลองใหม่อีกครั้งในอีกสักครู่\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" },
    });
  }
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
