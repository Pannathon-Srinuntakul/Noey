import { Fragment, type CSSProperties, type ReactNode } from "react";

type HeadingTag = "h1" | "h2" | "h3" | "p" | "span" | "div";

const segmenter = new Intl.Segmenter("th", { granularity: "word" });

/**
 * A headline that comes in word by word, the way subtitles follow speech.
 *
 * Thai is never split into characters (vowels and tone marks would fall off
 * their consonants): words come from Intl.Segmenter, on the server, so the
 * HTML already holds the whole sentence as plain text. The element carries
 * the full sentence as its accessible name and the word spans are hidden from
 * assistive technology, so a screen reader reads one sentence, not pieces.
 *
 * Motion is added by MotionRuntime + CSS only: below the fold the words rise
 * in when scrolled to; in view at load they stay put and a gold "now
 * speaking" highlight runs across them. No JS / reduced motion: static text.
 *
 * A "\n" in `text` is a line break on desktop only; phones wrap by word.
 */
export function WordReveal({
  text,
  as: Tag = "h2",
  className,
  id,
  soft,
  children,
}: {
  text: string;
  as?: HeadingTag;
  className?: string;
  id?: string;
  /** Lines (0-based) drawn in the light weight: the quieter half of a heading. */
  soft?: readonly number[];
  children?: ReactNode;
}) {
  const lines = text.split("\n");
  let index = 0;
  return (
    <Tag id={id} className={["wr", className].filter(Boolean).join(" ")} aria-label={lines.join(" ")} data-reveal="words">
      {lines.map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 ? (
            <>
              <span className="br-sp" aria-hidden="true">
                {" "}
              </span>
              <br className="br-desk" />
            </>
          ) : null}
          <span className={soft?.includes(lineIndex) ? "wr__line h-soft" : "wr__line"} aria-hidden="true">
            {[...segmenter.segment(line)].map((part, partIndex) =>
              part.isWordLike ? (
                <span key={partIndex} className="wr__w" style={{ "--i": index++ } as CSSProperties}>
                  {part.segment}
                </span>
              ) : (
                <Fragment key={partIndex}>{part.segment}</Fragment>
              ),
            )}
          </span>
        </Fragment>
      ))}
      {children}
    </Tag>
  );
}
