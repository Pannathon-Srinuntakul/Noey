import Link from "next/link";
import type { ReactNode } from "react";
import { Waveform } from "./Waveform";

/**
 * A card drawn as a clip on a timeline: a thin header strip with the track
 * label, a timecode and a strip of waveform; the body underneath. Hover or
 * focus selects it the way an editor selects a clip — gold outline, trim
 * handles on both edges.
 *
 * With `href` the whole card is one link (its title is the link text).
 */
export function ClipCard({
  title,
  titleAs: Title = "h3",
  track,
  timecode,
  seed = 3,
  tone = "default",
  href,
  prefetch,
  className,
  media,
  children,
}: {
  title: ReactNode;
  titleAs?: "h2" | "h3" | "h4" | "p";
  track?: string;
  timecode?: string;
  seed?: number;
  tone?: "default" | "gold" | "muted";
  href?: string;
  prefetch?: boolean;
  className?: string;
  /** Replaces the strip's waveform with something of the card's own (a micro-demo). */
  media?: ReactNode;
  children?: ReactNode;
}) {
  const classes = ["clip", `clip--${tone}`, href ? "clip--link" : null, className].filter(Boolean).join(" ");
  return (
    <article className={classes}>
      <div className="clip__strip" aria-hidden="true">
        {track ? <span className="trk tc">{track}</span> : null}
        {media ?? <Waveform bars={36} seed={seed} className="clip__wave" />}
        {timecode ? <span className="tc clip__tc">{timecode}</span> : null}
      </div>
      <div className="clip__body">
        <Title className="clip__title">
          {href ? (
            <Link href={href} prefetch={prefetch} className="clip__link">
              {title}
            </Link>
          ) : (
            title
          )}
        </Title>
        {children}
      </div>
    </article>
  );
}
