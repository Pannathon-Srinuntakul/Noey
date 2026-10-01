"use client";

import Image from "next/image";
import { useCallback, useState, type CSSProperties, type SyntheticEvent } from "react";

/**
 * A picture inside a post: next/image at its real size when the server
 * could measure it, a plain lazy <img> in a 16:9 frame when it could not.
 *
 * When the file does not load (a 404 from the media store, a network
 * failure) it gives way to a neutral frame of the same shape with the
 * picture's description in it; the figure's caption stays under it. A
 * failure before hydration reaches next/image as a load with no pixels, so
 * both events are checked, and so is an image already complete when React
 * gets it. Without JavaScript the frame is drawn by CSS over the broken
 * image (`.blog-figure__img::before`, blog.css).
 *
 * `inline`: a picture inside a line of text; a failure leaves just its
 * description in the line.
 */
export function FigureImage({
  src,
  alt,
  width,
  height,
  sizes,
  eager,
  unoptimized,
  inline,
}: {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
  sizes: string;
  eager: boolean;
  unoptimized: boolean;
  inline: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const check = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0 && image.currentSrc) setFailed(true);
  }, []);
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.naturalWidth === 0) setFailed(true);
  };
  const sized = width !== null && height !== null;

  if (failed) {
    if (inline) return alt ? <span className="blog-inline-img__missing">{alt}</span> : null;
    return (
      <span
        className="blog-figure__missing"
        style={sized ? ({ "--figure-ratio": `${width} / ${height}` } as CSSProperties) : undefined}
        {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}
      >
        {/* Seen, not read twice: the frame's own name is the description. */}
        {alt ? (
          <span className="blog-figure__missing-text" aria-hidden="true">
            {alt}
          </span>
        ) : null}
      </span>
    );
  }

  if (sized) {
    return (
      <Image
        ref={check}
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        className="blog-figure__img"
        unoptimized={unoptimized}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        decoding="async"
        onError={() => setFailed(true)}
        onLoad={onLoad}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- no known size: drawn as it comes, lazily, in a fixed frame
    <img
      ref={check}
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className="blog-figure__img blog-figure__img--unsized"
      onError={() => setFailed(true)}
      onLoad={onLoad}
    />
  );
}
