"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * An in-article visual (`::visual[alt](id)`): HTML from the backend's
 * cookieless embed origin, shown so it behaves exactly like a picture.
 *
 * The markup is the spec's (BLOG_MEDIA_PROMPT.md §3, BLOG_CONTRACT.md):
 *  - `aspect-ratio: W / H` on the figure from the designed canvas, so the
 *    space is reserved before anything loads (no layout shift);
 *  - `sandbox="allow-scripts"` and nothing else — no same-origin, no
 *    top navigation, no popups, no forms — on another origin with no cookies;
 *  - out of the tab order and hidden from assistive tech; the alt text is in
 *    the page as `.sr-only` text, so search engines and screen readers read it;
 *  - `pointer-events: none`: it cannot be clicked, selected or scrolled.
 *
 * Motion (§3): an IntersectionObserver tells the visual `pause` when it
 * leaves the screen and `play` when it comes back; under
 * `prefers-reduced-motion: reduce` it is only ever told `pause` (the visual
 * also checks the setting itself and stays still). Messages go with target
 * "*": a sandboxed frame's origin is opaque, so no other target can reach it,
 * and nothing secret is ever sent.
 */
export function BlogVisual({
  src,
  alt,
  caption,
  width,
  height,
}: {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // "ssr" until hydrated: without JavaScript the frame is simply shown. With
  // it, a frame still loading is faded in once it has drawn.
  const [phase, setPhase] = useState<"ssr" | "loading" | "loaded">("ssr");

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let visible = false;
    const send = () => {
      const play = visible && !reduced?.matches;
      iframe.contentWindow?.postMessage({ type: play ? "play" : "pause" }, "*");
    };
    const onLoad = () => {
      setPhase("loaded");
      send();
    };
    iframe.addEventListener("load", onLoad);
    // A frame that finished loading before hydration fired its load event
    // unseen: its navigation is already in the resource timing buffer.
    const already = performance.getEntriesByName?.(src).some((entry) => (entry as PerformanceResourceTiming).responseEnd > 0);
    setPhase(already ? "loaded" : "loading");
    send();
    // Never leave a visual invisible because an event was missed.
    const fallback = window.setTimeout(() => setPhase("loaded"), 4000);
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) visible = entry.isIntersecting;
              send();
            },
            { rootMargin: "120px 0px" },
          )
        : null;
    observer?.observe(iframe);
    const onMotion = () => send();
    reduced?.addEventListener?.("change", onMotion);
    return () => {
      window.clearTimeout(fallback);
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
      reduced?.removeEventListener?.("change", onMotion);
    };
  }, [src]);

  return (
    <figure className={`visual${phase === "loading" ? " is-loading" : ""}`} style={{ aspectRatio: `${width} / ${height}` } as CSSProperties}>
      <iframe
        ref={frame}
        src={src}
        sandbox="allow-scripts"
        loading="lazy"
        tabIndex={-1}
        aria-hidden="true"
        scrolling="no"
        referrerPolicy="no-referrer"
        title=""
        style={{ width: "100%", height: "100%", border: 0, display: "block", pointerEvents: "none" }}
      />
      <span className="sr-only">{alt}</span>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
