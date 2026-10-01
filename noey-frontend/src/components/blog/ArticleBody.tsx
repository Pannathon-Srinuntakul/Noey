import type { Element, ElementContent, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { IconExternal } from "@/components/ds/icons";
import { allowedImageUrl, isUnderMediaBase } from "@/lib/blog";
import { blogMediaBase } from "@/lib/blog-media";
import { linkTarget } from "@/lib/blog-markdown";
import { blogImageSize } from "@/lib/server/blog-images";
import { SITE_URL } from "@/lib/site";
import { BlogImage } from "./BlogImage";

/**
 * Renders a post's sanitised Markdown tree (lib/blog-markdown.ts) with the
 * site's own parts: internal links are client-side links (no nofollow),
 * links out open in a new tab with rel="noopener nofollow" and say so,
 * images are next/image at their real size (no layout shift), tables scroll
 * inside their frame on a phone. Server component; no raw HTML anywhere.
 */

const SITE_HOSTS = [new URL(SITE_URL).host.toLowerCase(), "noeystudio.com", "www.noeystudio.com"];

function MarkdownLink({ href, children, className, ...rest }: ComponentProps<"a">) {
  const link = linkTarget(href, SITE_HOSTS);
  if (!link) return <span>{children}</span>;
  if (link.kind === "anchor") {
    return (
      <a {...rest} className={className} href={link.href}>
        {children}
      </a>
    );
  }
  if (link.kind === "internal") {
    return (
      <Link {...rest} className={className} href={link.href} prefetch={false}>
        {children}
      </Link>
    );
  }
  return (
    <a {...rest} href={link.href} target="_blank" rel="noopener nofollow" className={["ext-link", className].filter(Boolean).join(" ")}>
      {children}
      <span className="sr-only"> (เปิดในแท็บใหม่)</span>
      <IconExternal size={13} className="ext-link__icon" />
    </a>
  );
}

type ImageProps = ComponentProps<"img"> & { "data-standalone"?: string; "data-eager"?: string };

const FIGURE_SIZES = "(min-width: 1200px) 660px, (min-width: 720px) 660px, calc(100vw - 32px)";

async function MarkdownImage({ src, alt, title, "data-standalone": standalone, "data-eager": eager }: ImageProps) {
  const base = blogMediaBase();
  const url = allowedImageUrl(src, base);
  if (!url) return null;
  // Only the media store's own files are fetched to read their size: an
  // image elsewhere is never requested by this server.
  const size = base && isUnderMediaBase(url, base) ? await blogImageSize(url.toString()) : null;
  const text = typeof alt === "string" ? alt : "";
  const picture = size ? (
    <BlogImage
      src={url.toString()}
      alt={text}
      width={size.width}
      height={size.height}
      sizes={FIGURE_SIZES}
      className="blog-figure__img"
      eager={eager !== undefined}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- no known size: drawn as it comes, lazily, in a fixed frame
    <img
      src={url.toString()}
      alt={text}
      loading={eager !== undefined ? "eager" : "lazy"}
      decoding="async"
      className="blog-figure__img blog-figure__img--unsized"
    />
  );
  if (standalone === undefined) return <span className="blog-inline-img">{picture}</span>;
  return (
    <figure className="blog-figure">
      {picture}
      {/* A caption only from the image's own title: repeating the alt text would read twice. */}
      {title ? <figcaption>{title}</figcaption> : null}
    </figure>
  );
}

function MarkdownTable(props: ComponentProps<"table">) {
  return (
    <div className="blog-table" role="region" aria-label="ตาราง" tabIndex={0}>
      <table {...props} className="table" />
    </div>
  );
}

const COMPONENTS: Partial<Components> = {
  a: MarkdownLink as Components["a"],
  img: MarkdownImage as unknown as Components["img"],
  table: MarkdownTable as Components["table"],
};

/** Hast content → React, with the site's components. */
export function renderHast(content: Element | ElementContent[] | Root): ReactNode {
  const root: Root =
    "type" in content && content.type === "root"
      ? content
      : { type: "root", children: Array.isArray(content) ? content : [content as Element] };
  return toJsxRuntime(root, { Fragment, jsx, jsxs, components: COMPONENTS, passNode: false });
}
