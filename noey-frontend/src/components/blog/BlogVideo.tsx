"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * A demo clip from the media library (`![alt](….mp4)`): a silent loop that
 * plays like a moving picture, inside the same frame as the post's images.
 *
 * The spec's markup is `<video autoplay muted loop playsinline preload="none"
 * poster>`; the owner's rule is that it never moves for a reader who asked
 * for reduced motion. A server-rendered `autoplay` would start the clip
 * before this component could check that setting, so the server sends the
 * clip still — poster shown, controls on, nothing downloaded beyond (for the
 * first clip of the post) its metadata — and once hydrated:
 *  - motion allowed: controls off, `autoplay` set, and the clip plays while
 *    it is on screen (paused off screen, so clips below the fold cost
 *    nothing until reached);
 *  - reduced motion: it stays as it is — poster and controls, never autoplay.
 * Without JavaScript it is the same still, playable clip.
 */
export function BlogVideo({
  src,
  poster,
  alt,
  caption,
  width,
  height,
  first,
  inline = false,
}: {
  src: string;
  poster: string | null;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
  first: boolean;
  /** Inside a line of text: no figure (a <figure> may not sit in a <p>), no caption. */
  inline?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let visible = false;
    const apply = () => {
      const allowed = !reduced?.matches;
      setMotion(allowed);
      video.autoplay = allowed;
      video.controls = !allowed;
      if (allowed && visible) void video.play().catch(() => undefined);
      else if (!video.paused && (!allowed || !visible)) video.pause();
    };
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) visible = entry.isIntersecting;
            apply();
          }, { rootMargin: "120px 0px" })
        : null;
    observer?.observe(video);
    if (!observer) visible = true;
    apply();
    reduced?.addEventListener?.("change", apply);
    return () => {
      observer?.disconnect();
      reduced?.removeEventListener?.("change", apply);
    };
  }, []);

  const sized = width !== null && height !== null;
  const clip = (
      <video
        ref={ref}
        className="blog-figure__img blog-video__clip"
        muted
        loop
        playsInline
        controls={!motion}
        preload={first ? "metadata" : "none"}
        poster={poster ?? undefined}
        width={width ?? undefined}
        height={height ?? undefined}
        aria-label={caption ? undefined : alt}
        style={sized ? ({ aspectRatio: `${width} / ${height}` } as CSSProperties) : undefined}
      >
        <source src={src} type="video/mp4" />
      </video>
  );
  if (inline) return <span className="blog-inline-img blog-video">{clip}</span>;
  return (
    <figure className="blog-figure blog-video">
      {clip}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
