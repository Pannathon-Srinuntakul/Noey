import type { CSSProperties } from "react";
import type { BlogCover } from "@/lib/blog";
import { isOptimizable } from "./BlogImage";
import { CoverImage } from "./CoverImage";
import { Slate } from "./Slate";

interface CoverPost {
  slug: string;
  cover: BlogCover | null;
  category: { name: string };
}

/** Widest and tallest a post's own cover is shown at its natural shape; outside that it is cut to 16:9. */
const MIN_RATIO = 4 / 3;
const MAX_RATIO = 21 / 9;

/**
 * A post's cover: its picture, or the slate drawn from the post when it has
 * none — or when the picture fails to load (CoverImage). The frame behind a
 * picture is the slate's ground, so a cover still loading leaves a
 * deliberate frame, not a hole.
 *
 * `card`: every cover cut to 16:9 (a listing reads as one strip of frames).
 * `hero`: the post's own page, at the picture's shape when it is a sensible
 * one, fetched first.
 */
export function PostCover({ post, variant, sizes, eager }: { post: CoverPost; variant: "card" | "feature" | "hero"; sizes: string; eager?: boolean }) {
  const cover = post.cover;
  if (!cover) {
    return (
      <div className={`cover cover--${variant} cover--slate`}>
        <Slate slug={post.slug} category={post.category.name} size={variant} />
      </div>
    );
  }
  const common = {
    src: cover.url,
    sizes,
    unoptimized: !isOptimizable(cover.url),
    slug: post.slug,
    category: post.category.name,
    slateSize: variant,
  } as const;
  const ratio = cover.width && cover.height ? cover.width / cover.height : null;
  if (variant === "hero" && cover.width && cover.height && ratio && ratio >= MIN_RATIO && ratio <= MAX_RATIO) {
    return (
      <figure className="cover cover--hero" style={{ "--cover-ratio": `${cover.width} / ${cover.height}` } as CSSProperties}>
        <CoverImage {...common} alt={cover.alt} width={cover.width} height={cover.height} eager />
      </figure>
    );
  }
  return (
    <figure className={`cover cover--${variant}`}>
      <CoverImage {...common} alt={variant === "hero" ? cover.alt : ""} fill eager={eager ?? variant !== "card"} />
    </figure>
  );
}
