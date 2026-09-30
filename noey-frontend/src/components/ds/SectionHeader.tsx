import type { ReactNode } from "react";
import { WordReveal } from "./WordReveal";

/**
 * A section opens like a track in the editor: a track label (V1, A2…), a
 * timecode, then the section's own eyebrow in Thai, then the heading, which
 * comes in word by word. Track and timecode are decoration; the eyebrow and
 * heading are the content.
 */
export function SectionHeader({
  id,
  title,
  eyebrow,
  track,
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
      {track || timecode || eyebrow ? (
        <div className="sec-head__label">
          {track ? (
            <span className="trk tc" aria-hidden="true">
              {track}
            </span>
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
