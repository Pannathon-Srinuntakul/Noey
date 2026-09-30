"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { formatTimecode, waveform } from "../ds/timecode";
import { wavePath } from "../ds/Waveform";

/**
 * A guide's thumbnail in the media bin, generated from the guide itself — no
 * stock images: its file name, a cue where each section starts (placed by
 * the length of the text before it), and a waveform whose loud and quiet
 * stretches follow its long and short paragraphs. Hovering
 * the thumbnail scrubs it like a clip in an editor's bin: the playhead
 * follows the pointer and the timecode reads the position. Decorative.
 *
 * The card's link covers the whole card (so the thumbnail is clickable too),
 * which means the pointer is over the link, not over this element — so the
 * scrub listens on the card and checks the thumbnail's own box.
 */
export function BinThumb({
  name,
  sections,
  paragraphs,
  seed,
  length,
}: {
  name: string;
  /** Characters in each section, in order. */
  sections: readonly number[];
  /** Characters in each paragraph, in order. */
  paragraphs: readonly number[];
  seed: number;
  length: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  // Where each section after the first starts, as a share of the whole text.
  const total = sections.reduce((sum, size) => sum + size, 0) || 1;
  const cues: number[] = [];
  let before = 0;
  for (const size of sections.slice(0, -1)) {
    before += size;
    cues.push(before / total);
  }

  // Each bar sits over a paragraph: longer paragraphs read louder; the seeded
  // wave adds the texture of speech on top.
  const texture = waveform(64, seed);
  const paragraphTotal = paragraphs.reduce((sum, size) => sum + size, 0) || 1;
  const longest = Math.max(1, ...paragraphs);
  const heights = texture.map((grain, index) => {
    const at = ((index + 0.5) / texture.length) * paragraphTotal;
    let edge = 0;
    const size = paragraphs.find((paragraph) => (edge += paragraph) >= at) ?? longest;
    return Math.min(1, Math.max(0.1, (0.25 + 0.75 * (size / longest)) * (0.45 + grain * 0.7)));
  });
  const bars = wavePath(heights, "bottom");

  useEffect(() => {
    const element = box.current;
    const card = element?.parentElement;
    if (!element || !card) return;
    const reset = () => {
      element.removeAttribute("data-scrub");
      element.style.removeProperty("--x");
      if (readout.current) readout.current.textContent = formatTimecode(length);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const rect = element.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY > rect.bottom) {
        reset();
        return;
      }
      const at = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      element.setAttribute("data-scrub", "");
      element.style.setProperty("--x", `${(at * 100).toFixed(2)}%`);
      if (readout.current) readout.current.textContent = formatTimecode(at * length);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerleave", reset);
    return () => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerleave", reset);
    };
  }, [length]);

  return (
    <div
      ref={box}
      className="bin-thumb"
      aria-hidden="true"
      style={{ "--gx": `${10 + ((seed * 29) % 60)}%` } as CSSProperties}
    >
      <span className="bin-thumb__glow" />
      <span className="bin-thumb__marks">
        {cues.map((at, index) => (
          <i key={index} style={{ left: `${(at * 100).toFixed(2)}%` }} />
        ))}
      </span>
      <svg className="bin-thumb__wave" viewBox="0 0 192 100" preserveAspectRatio="none" focusable="false">
        <path d={bars} />
      </svg>
      <span className="bin-thumb__played" />
      <span className="bin-thumb__head" />
      <span className="bin-thumb__name tc">{name}</span>
      <span className="bin-thumb__tc tc" ref={readout}>
        {formatTimecode(length)}
      </span>
    </div>
  );
}
