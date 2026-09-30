import type { CSSProperties } from "react";
import "../../styles/parts/level.css";

/**
 * A usage bar drawn as an audio level meter: a row of segments that light up
 * from the left, the last ones turning to the warning colours as the level
 * climbs (the editor's thresholds: 80% near, 95% full). The lit segments
 * rise in when the meter is shown; with reduced motion they are simply lit.
 *
 * Pass `labelledBy` to expose it as a progress bar; without it the meter is
 * decorative (the percentage is printed next to it anyway).
 */
export function LevelMeter({
  value,
  labelledBy,
  segments = 28,
  className,
}: {
  /** 0–100. */
  value: number;
  labelledBy?: string;
  segments?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const lit = Math.round((pct / 100) * segments);
  const tone = pct >= 95 ? "full" : pct >= 80 ? "near" : "ok";
  const a11y = labelledBy
    ? { role: "progressbar" as const, "aria-labelledby": labelledBy, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct) }
    : { "aria-hidden": true as const };
  return (
    <div className={["lvl", `lvl--${tone}`, className].filter(Boolean).join(" ")} data-reveal="level" {...a11y}>
      {Array.from({ length: segments }, (_, index) => (
        <i
          key={index}
          data-on={index < lit ? "" : undefined}
          data-hot={index >= Math.floor(segments * 0.8) ? "" : undefined}
          style={{ "--i": index } as CSSProperties}
        />
      ))}
    </div>
  );
}
