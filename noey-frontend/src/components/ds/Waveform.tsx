import type { CSSProperties } from "react";
import { waveform } from "./timecode";

/**
 * The bars of a waveform as ONE SVG path: vertical strokes, `anchor`ed at the
 * middle (speech) or the bottom (a thumbnail's level). Stretched to its box
 * (`preserveAspectRatio="none"`); the stroke is two thirds of each bar's
 * pitch at any width.
 */
export function wavePath(heights: readonly number[], anchor: "middle" | "bottom" = "middle"): string {
  return heights
    .map((height, index) => {
      const x = index * 3 + 1.5;
      if (anchor === "bottom") return `M${x} 100V${Math.round(100 - Math.max(3, height * 100))}`;
      const half = Math.max(3, Math.round(height * 48));
      return `M${x} ${50 - half}V${50 + half}`;
    })
    .join("");
}

/**
 * A speech-like waveform drawn as bars (deterministic per `seed`, so server
 * and client agree). Decorative.
 *
 * Two renderings:
 * - animated (default): one element per bar, so `data-play` on an ancestor
 *   can make the bars breathe and the mockups can raise them one by one;
 * - `still`: a single SVG path — for the many places the waveform never
 *   moves (clip cards, locked tracks). One element instead of dozens keeps
 *   the page's HTML and RSC payload small.
 */
export function Waveform({
  bars = 64,
  seed = 7,
  className,
  cut,
  still = false,
}: {
  bars?: number;
  seed?: number;
  className?: string;
  /** Bar ranges [from, to) drawn as cut out (struck takes). */
  cut?: ReadonlyArray<readonly [number, number]>;
  still?: boolean;
}) {
  const heights = waveform(bars, seed);
  if (still) {
    return (
      <svg
        className={["wave wave--still", className].filter(Boolean).join(" ")}
        viewBox={`0 0 ${bars * 3} 100`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d={wavePath(heights)} />
      </svg>
    );
  }
  return (
    <span className={["wave", className].filter(Boolean).join(" ")} aria-hidden="true">
      {heights.map((height, index) => {
        const isCut = cut?.some(([from, to]) => index >= from && index < to);
        return (
          <i
            key={index}
            className={isCut ? "wave__bar wave__bar--cut" : "wave__bar"}
            style={{ "--h": height.toFixed(3), "--i": index } as CSSProperties}
          />
        );
      })}
    </span>
  );
}
