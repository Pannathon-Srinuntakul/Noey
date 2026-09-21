import Image from "next/image";
import type { MediaEntry } from "@/lib/media";
import { NoeyMark } from "./NoeyMark";

/**
 * Replaces the prototype's <image-slot>. The box reserves its aspect ratio up
 * front (zero CLS) and wears the design's `.plate` frame; until the owner
 * supplies media it shows a quiet branded placeholder.
 */
export function MediaSlot({
  media,
  className,
  sizes = "(max-width: 700px) 90vw, 320px",
  priority = false,
}: {
  media: MediaEntry;
  className?: string;
  /** `sizes` for responsive images. */
  sizes?: string;
  /** Mark the LCP image (hero) for eager loading. */
  priority?: boolean;
}) {
  const classes = ["media-slot", "plate", className].filter(Boolean).join(" ");
  const style = { aspectRatio: media.ratio };

  if (media.src && media.kind === "video") {
    return (
      <div className={classes} style={style}>
        <video
          src={media.src}
          poster={media.poster}
          aria-label={media.alt}
          muted
          loop
          playsInline
          controls
          preload="metadata"
        />
      </div>
    );
  }

  if (media.src) {
    return (
      <div className={classes} style={style}>
        <Image src={media.src} alt={media.alt ?? ""} fill sizes={sizes} priority={priority} />
      </div>
    );
  }

  return (
    <div className={classes} style={style} data-media-slot="empty">
      <div className="media-slot__placeholder" aria-hidden="true">
        <NoeyMark size={40} />
        <span className="media-slot__label">{media.placeholderLabel}</span>
      </div>
    </div>
  );
}
