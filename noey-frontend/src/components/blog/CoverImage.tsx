"use client";

import Image from "next/image";
import { useCallback, useState, type SyntheticEvent } from "react";
import { Slate } from "./Slate";

/**
 * A post's cover picture that falls back to the post's slate when the file
 * does not load (a 404 from the media store, a network failure). next/image
 * may report a failure that happened before hydration as a load of an image
 * with no pixels, so both events are checked, and so is an image already
 * complete when React gets it.
 *
 * Without JavaScript the failure is covered by CSS instead (`.cover__img`
 * draws the slate's ground over a broken image, blog.css): never the
 * browser's broken-image glyph.
 */
export function CoverImage({
  src,
  alt,
  width,
  height,
  fill = false,
  sizes,
  eager = false,
  unoptimized,
  slug,
  category,
  slateSize,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  sizes: string;
  eager?: boolean;
  unoptimized: boolean;
  slug: string;
  category: string;
  slateSize: "card" | "feature" | "hero";
}) {
  const [failed, setFailed] = useState(false);
  const check = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0 && image.currentSrc) setFailed(true);
  }, []);
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.naturalWidth === 0) setFailed(true);
  };
  if (failed) return <Slate slug={slug} category={category} size={slateSize} />;
  return (
    <Image
      ref={check}
      src={src}
      alt={alt}
      {...(fill ? { fill: true } : { width, height })}
      sizes={sizes}
      className="cover__img"
      unoptimized={unoptimized}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      decoding="async"
      onError={() => setFailed(true)}
      onLoad={onLoad}
    />
  );
}
