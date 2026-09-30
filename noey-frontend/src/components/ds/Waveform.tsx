import type { CSSProperties } from "react";
import { waveform } from "./timecode";

/**
 * A speech-like waveform drawn as bars (deterministic per `seed`, so server
 * and client agree). Decorative. `data-play` on an ancestor lets CSS make it
 * breathe while it is on screen.
 */
export function Waveform({
  bars = 64,
  seed = 7,
  className,
  cut,
}: {
  bars?: number;
  seed?: number;
  className?: string;
  /** Bar ranges [from, to) drawn as cut out (struck takes). */
  cut?: ReadonlyArray<readonly [number, number]>;
}) {
  const heights = waveform(bars, seed);
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
