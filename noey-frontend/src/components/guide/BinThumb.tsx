"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { formatTimecode, waveform } from "../ds/timecode";

/**
 * A guide's thumbnail in the media bin, generated from the guide itself
 * (its file name, a cue per section, a waveform) — no stock images. Hovering
 * the thumbnail scrubs it like a clip in an editor's bin: the playhead
 * follows the pointer and the timecode reads the position. Decorative.
 *
 * The card's link covers the whole card (so the thumbnail is clickable too),
 * which means the pointer is over the link, not over this element — so the
 * scrub listens on the card and checks the thumbnail's own box.
 */
export function BinThumb({ name, sections, seed, length }: { name: string; sections: number; seed: number; length: number }) {
  const box = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const bars = waveform(64, seed);

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
        {Array.from({ length: sections }, (_, index) => (
          <i key={index} style={{ left: `${((index + 0.5) / sections) * 100}%` }} />
        ))}
      </span>
      <span className="bin-thumb__wave">
        {bars.map((height, index) => (
          <i key={index} style={{ "--h": height.toFixed(3) } as CSSProperties} />
        ))}
      </span>
      <span className="bin-thumb__played" />
      <span className="bin-thumb__head" />
      <span className="bin-thumb__name tc">{name}</span>
      <span className="bin-thumb__tc tc" ref={readout}>
        {formatTimecode(length)}
      </span>
    </div>
  );
}
