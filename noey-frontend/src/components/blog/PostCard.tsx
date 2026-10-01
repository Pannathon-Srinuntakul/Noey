import Link from "next/link";
import type { CSSProperties } from "react";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { BLOG_COPY, blogPostPath, type BlogCover, type BlogRef } from "@/lib/blog";
import { formatThaiDate } from "@/lib/format";
import { PostCover } from "./PostCover";

/** The reading-length strip's full scale: a 15-minute read fills it. */
const LENGTH_SCALE_MIN = 15;

export interface CardPost {
  slug: string;
  title: string;
  excerpt: string;
  cover: BlogCover | null;
  category: BlogRef;
  publishedAt: string;
  readingMinutes?: number;
}

/**
 * A post in a listing, drawn as a clip in the editor's bin: its cover (or
 * its slate) as the clip's frame, the category on a track label, the title
 * as the one link that covers the whole card, the excerpt, the date and the
 * reading time, drawn as the clip's length on a strip at the foot — one
 * scale for every card, so long and short reads show at a glance (a picture
 * of "อ่าน N นาที", never a second number).
 *
 * `feature`: the newest post, wide, at the head of the first page.
 */
export function PostCard({
  post,
  track,
  titleAs: Title = "h2",
  variant = "card",
  sizes,
  eagerCover,
}: {
  post: CardPost;
  /** The category's track label (V1, V2 …), from its place in the category list. */
  track?: string;
  titleAs?: "h2" | "h3";
  variant?: "card" | "feature" | "compact";
  sizes?: string;
  /** The first picture on a page with no featured post: fetched at once, like the feature's. */
  eagerCover?: boolean;
}) {
  const minutes = post.readingMinutes;
  const share = minutes ? Math.min(1, minutes / LENGTH_SCALE_MIN) : null;
  return (
    <article className={`clip clip--link post-card post-card--${variant}`}>
      {variant === "compact" ? null : (
        <PostCover
          post={post}
          variant={variant === "feature" ? "feature" : "card"}
          eager={eagerCover}
          sizes={sizes ?? (variant === "feature" ? "(min-width: 1024px) 720px, calc(100vw - 32px)" : "(min-width: 1100px) 400px, (min-width: 700px) 50vw, calc(100vw - 32px)")}
        />
      )}
      <div className="clip__body post-card__body">
        <p className="post-card__eyebrow">
          {track ? (
            <span className="trk tc" aria-hidden="true">
              {track}
            </span>
          ) : null}
          <span className="post-card__cat">{post.category.name}</span>
          {variant === "feature" ? <span className="tag tag-accent post-card__new">{BLOG_COPY.newest}</span> : null}
        </p>
        <Title className="clip__title post-card__title">
          <Link href={blogPostPath(post.slug)} className="clip__link">
            {keepThaiProse(post.title)}
          </Link>
        </Title>
        {post.excerpt ? <p className="post-card__excerpt">{keepThaiProse(post.excerpt)}</p> : null}
        <p className="post-card__meta">
          <time dateTime={post.publishedAt}>{formatThaiDate(post.publishedAt)}</time>
          {minutes ? (
            <>
              <span className="post-card__dot" aria-hidden="true">
                ·
              </span>
              <span>{BLOG_COPY.readMinutes(minutes)}</span>
            </>
          ) : null}
        </p>
        {share !== null && minutes ? (
          <span className="post-card__length" aria-hidden="true" style={{ "--len": share.toFixed(3) } as CSSProperties}>
            <span className="post-card__len-bar" />
          </span>
        ) : null}
      </div>
    </article>
  );
}
