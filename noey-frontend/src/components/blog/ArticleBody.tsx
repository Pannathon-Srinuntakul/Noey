import type { Element, ElementContent, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { IconExternal } from "@/components/ds/icons";
import { allowedImageUrl, isUnderMediaBase, type BlogMedia } from "@/lib/blog";
import { blogMediaBase } from "@/lib/blog-media";
import { isVideoSrc, linkTarget } from "@/lib/blog-markdown";
import { blogImageSize } from "@/lib/server/blog-images";
import { SITE_URL } from "@/lib/site";
import { isOptimizable } from "./BlogImage";
import { BlogVideo } from "./BlogVideo";
import { BlogVisual } from "./BlogVisual";
import { FigureImage } from "./FigureImage";

/**
 * Renders a post's sanitised Markdown tree (lib/blog-markdown.ts) with the
 * site's own parts: internal links are client-side links (no nofollow),
 * links out open in a new tab with rel="noopener nofollow" and say so,
 * images are next/image at their real size (no layout shift) and give way
 * to a plain frame when the file does not load (FigureImage), tables scroll
 * inside their frame on a phone. Server component; no raw HTML anywhere.
 *
 * The post's `media` list (BLOG_CONTRACT.md) gives every body picture its
 * size up front: images, library videos (BlogVideo) and HTML visuals
 * (BlogVisual — a `::visual` placeholder from lib/blog-markdown.ts).
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

type ImageProps = ComponentProps<"img"> & { "data-standalone"?: string; "data-eager"?: string; "data-first-video"?: string };

const FIGURE_SIZES = "(min-width: 1200px) 660px, (min-width: 720px) 660px, calc(100vw - 32px)";

async function MarkdownImage({
  src,
  alt,
  title,
  "data-standalone": standalone,
  "data-eager": eager,
  "data-first-video": firstVideo,
  media,
}: ImageProps & { media: MediaIndex }) {
  const base = blogMediaBase();
  const url = allowedImageUrl(src, base);
  if (!url) return null;
  const known = media.byUrl.get(url.toString());
  const text = typeof alt === "string" ? alt : "";
  if (isVideoSrc(url.pathname)) {
    // A clip is only ever one of the store's own files, drawn as its own figure.
    if (!base || !isUnderMediaBase(url, base)) return null;
    const video = known?.type === "video" ? known : null;
    return (
      <BlogVideo
        src={url.toString()}
        poster={video?.posterUrl ?? null}
        alt={text}
        caption={typeof title === "string" && title ? title : text}
        width={video?.width ?? null}
        height={video?.height ?? null}
        first={firstVideo !== undefined}
        inline={standalone === undefined}
      />
    );
  }
  // The size the API reported, else read from the file — only the media
  // store's own files are fetched: an image elsewhere is never requested here.
  const listed = known?.type === "image" && known.width && known.height ? { width: known.width, height: known.height } : null;
  const size = listed ?? (base && isUnderMediaBase(url, base) ? await blogImageSize(url.toString()) : null);
  const picture = (
    <FigureImage
      src={url.toString()}
      alt={text}
      width={size?.width ?? null}
      height={size?.height ?? null}
      sizes={FIGURE_SIZES}
      eager={eager !== undefined}
      // Only a measured file from the media store goes through the optimiser.
      unoptimized={!size || !isOptimizable(url.toString())}
      inline={standalone === undefined}
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

/** Code wider than the column scrolls inside its frame, and a keyboard can scroll it too. */
function MarkdownPre(props: ComponentProps<"pre">) {
  return <pre {...props} tabIndex={0} />;
}

/** The post's media list, looked up by URL (images, videos) and id (visuals). */
export interface MediaIndex {
  byUrl: Map<string, BlogMedia>;
  byVisual: Map<string, Extract<BlogMedia, { type: "visual" }>>;
}

export function mediaIndex(media: readonly BlogMedia[] = []): MediaIndex {
  const index: MediaIndex = { byUrl: new Map(), byVisual: new Map() };
  for (const item of media) {
    if (item.type === "visual") index.byVisual.set(item.id, item);
    else index.byUrl.set(item.url, item);
  }
  return index;
}

/** A `<div data-visual>` placeholder → the visual; any other div as it is. */
function MarkdownDiv({ media, ...props }: ComponentProps<"div"> & { "data-visual"?: string; "data-alt"?: string; media: MediaIndex }) {
  const id = props["data-visual"];
  if (id === undefined) return <div {...props} />;
  const visual = media.byVisual.get(id);
  // An id the API does not list (deleted, or never made) draws nothing.
  if (!visual) return null;
  return (
    <BlogVisual
      src={visual.src}
      alt={(props["data-alt"] ?? "").trim() || visual.alt}
      caption={visual.caption}
      width={visual.width}
      height={visual.height}
    />
  );
}

const BASE_COMPONENTS: Partial<Components> = {
  pre: MarkdownPre as Components["pre"],
  a: MarkdownLink as Components["a"],
  table: MarkdownTable as Components["table"],
};

/** Hast content → React, with the site's components; `media` = the post's media list. */
export function renderHast(content: Element | ElementContent[] | Root, media: MediaIndex = mediaIndex()): ReactNode {
  const root: Root =
    "type" in content && content.type === "root"
      ? content
      : { type: "root", children: Array.isArray(content) ? content : [content as Element] };
  const components: Partial<Components> = {
    ...BASE_COMPONENTS,
    img: ((props: ImageProps) => <MarkdownImage {...props} media={media} />) as unknown as Components["img"],
    div: ((props: ComponentProps<"div">) => <MarkdownDiv {...props} media={media} />) as unknown as Components["div"],
  };
  return toJsxRuntime(root, { Fragment, jsx, jsxs, components, passNode: false });
}
