import type { CSSProperties } from "react";
import type { BlogCover } from "@/lib/blog";
import { BlogFillImage, BlogImage } from "./BlogImage";
import { Slate } from "./Slate";

interface CoverPost {
  slug: string;
  title: string;
  cover: BlogCover | null;
  category: { name: string };
  readingMinutes?: number;
}

/** Widest and tallest a post's own cover is shown at its natural shape; outside that it is cut to 16:9. */
const MIN_RATIO = 4 / 3;
const MAX_RATIO = 21 / 9;

/**
 * A post's cover: its picture, or the slate drawn from the post when it has
 * none. The frame behind a picture is the slate's ground, so a cover that is
 * still loading (or never loads) leaves a deliberate frame, not a hole.
 *
 * `card`: every cover cut to 16:9 (a listing reads as one strip of frames).
 * `hero`: the post's own page, at the picture's shape when it is a sensible
 * one, fetched first.
 */
export function PostCover({ post, variant, sizes }: { post: CoverPost; variant: "card" | "feature" | "hero"; sizes: string }) {
  const minutes = post.readingMinutes ?? 1;
  const cover = post.cover;
  if (!cover) {
    return (
      <div className={`cover cover--${variant} cover--slate`}>
        <Slate slug={post.slug} title={post.title} category={post.category.name} minutes={minutes} size={variant} />
      </div>
    );
  }
  const ratio = cover.width && cover.height ? cover.width / cover.height : null;
  if (variant === "hero" && cover.width && cover.height && ratio && ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
    return (
      <figure className="cover cover--hero" style={{ "--cover-ratio": `${cover.width} / ${cover.height}` } as CSSProperties}>
        <BlogImage src={cover.url} alt={cover.alt} width={cover.width} height={cover.height} sizes={sizes} className="cover__img" eager />
      </figure>
    );
  }
  return (
    <figure className={`cover cover--${variant}`}>
      <BlogFillImage src={cover.url} alt={variant === "hero" ? cover.alt : ""} sizes={sizes} className="cover__img" eager={variant !== "card"} />
    </figure>
  );
}
