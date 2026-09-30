import Image from "next/image";
import type { MediaEntry } from "@/lib/media";
import { StepMockup } from "./mockups/StepMockup";

/**
 * Replaces the prototype's <image-slot>. The box reserves its aspect ratio up
 * front (zero CLS). Until the owner supplies media (`src` in lib/media.ts) it
 * shows the coded illustration of that step, labelled "ภาพจำลอง"; the moment
 * a file is set, the real image or video takes its place — nothing else
 * changes.
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
  const classes = ["media-slot", className].filter(Boolean).join(" ");
  const style = { aspectRatio: media.ratio };

  if (media.src && media.kind === "video") {
    return (
      <div className={classes} style={style}>
        <video src={media.src} poster={media.poster} aria-label={media.alt} muted loop playsInline controls preload="metadata" />
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
    <div className={[classes, "media-slot--mock"].join(" ")} data-media-slot="mock">
      <StepMockup kind={media.mock} label={media.mockLabel} ratio={media.ratio} />
    </div>
  );
}
