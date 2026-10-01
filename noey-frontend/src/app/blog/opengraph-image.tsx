import { OG_COPY } from "@/lib/og-copy";
import { renderOgImage } from "@/lib/server/og";

// The blog listings' share image (lib/blog-seo.ts BLOG_SHARE_IMAGE), drawn
// like every other page's at build time with the bundled Thai font.
export const alt = OG_COPY.blog.alt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return renderOgImage(OG_COPY.blog);
}
