import type { ReactNode } from "react";
import { WordReveal } from "./WordReveal";

/**
 * A section opens like a track in the editor: a track label (V1, A2…), a
 * timecode, then the section's own eyebrow in Thai, then the heading, which
 * comes in word by word. Track and timecode are decoration; the eyebrow and
 * heading are the content.
 *
 * `marker` draws the section as a marker on the page's own timeline instead
 * of a track: the diamond the header's ruler shows for this heading, then the
 * time the ruler reads when the heading reaches it (ScrollTimeline). A page
 * that marks every section this way has no track label left to mean two
 * things on one page.
 */
export function SectionHeader({
  id,
  title,
  eyebrow,
  track,
  marker = false,
  timecode,
  as = "h2",
  align = "start",
  size = "h-2",
  soft,
  className,
  children,
}: {
  id?: string;
  title: string;
  eyebrow?: ReactNode;
  track?: string;
  marker?: boolean;
  timecode?: string;
  as?: "h1" | "h2" | "h3";
  align?: "start" | "center";
  size?: "h-display" | "h-1" | "h-2" | "h-3";
  soft?: readonly number[];
  className?: string;
  /** Intro paragraph(s) under the heading. */
  children?: ReactNode;
}) {
  return (
    <div className={["sec-head", align === "center" ? "sec-head--center" : null, className].filter(Boolean).join(" ")}>
      {track || marker || timecode || eyebrow ? (
        <div className="sec-head__label">
          {track ? (
            <span className="trk tc" aria-hidden="true">
              {track}
            </span>
          ) : marker ? (
            <span className="sec-head__marker" aria-hidden="true" />
          ) : null}
          {timecode ? (
            <span className="sec-head__tc tc" aria-hidden="true">
              {timecode}
            </span>
          ) : null}
          {eyebrow ? <span className="sec-head__eyebrow">{eyebrow}</span> : null}
          <span className="sec-head__rule" aria-hidden="true" />
        </div>
      ) : null}
      <WordReveal as={as} id={id} text={title} className={size} soft={soft} />
      {children ? <div className="sec-head__intro">{children}</div> : null}
    </div>
  );
}
