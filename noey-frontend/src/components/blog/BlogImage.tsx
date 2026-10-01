import Image from "next/image";
import { isUnderMediaBase } from "@/lib/blog";
import { blogMediaBase } from "@/lib/blog-media";

/**
 * Whether next/image may optimise `url`: only an https URL under the
 * configured media base — exactly what `images.remotePatterns` allows
 * (next.config.ts). Anything else is drawn as it is (`unoptimized`).
 */
export function isOptimizable(url: string): boolean {
  const base = blogMediaBase();
  if (!base || !base.startsWith("https:")) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && isUnderMediaBase(parsed, base);
  } catch {
    return false;
  }
}

/** A blog image, from the media store or another https origin, at a known size. */
export function BlogImage({
  src,
  alt,
  width,
  height,
  sizes,
  className,
  eager = false,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  sizes: string;
  className?: string;
  /** Near the top of the page (the cover, the post's opening picture): fetched at once, first. */
  eager?: boolean;
}) {
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      sizes={sizes}
      className={className}
      unoptimized={!isOptimizable(src)}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      decoding="async"
    />
  );
}
