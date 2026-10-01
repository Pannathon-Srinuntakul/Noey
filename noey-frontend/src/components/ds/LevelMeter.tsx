import type { CSSProperties } from "react";
import { limitTone } from "@/lib/usage-limits";
import "../../styles/parts/level.css";

/**
 * Segment counts, widest first. The meter draws as many segments as its own
 * width holds at a readable size (level.css picks one row by container
 * width), so a narrow meter is a short row of blocks, not a dotted line.
 */
const ROWS = [28, 20, 14] as const;

/**
 * A usage bar drawn as an audio level meter: a row of segments that light up
 * from the left, the last fifth turning to the warning colours as the level
 * climbs (the editor's thresholds: 80% near, 95% full — `limitTone`). One
 * rule everywhere: a row of N segments lights Math.round(pct × N) of them, so
 * the overview and the quota tab draw the same number the same way. The lit
 * segments rise in when the meter is shown; with reduced motion they are
 * simply lit.
 *
 * Pass `labelledBy` to expose it as a progress bar; without it the meter is
 * decorative (the percentage is printed next to it anyway).
 */
export function LevelMeter({
  value,
  labelledBy,
  className,
}: {
  /** 0–100. */
  value: number;
  labelledBy?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = limitTone(pct);
  const a11y = labelledBy
    ? { role: "progressbar" as const, "aria-labelledby": labelledBy, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct) }
    : { "aria-hidden": true as const };
  return (
    <div className={["lvl", `lvl--${tone}`, className].filter(Boolean).join(" ")} data-reveal="level" {...a11y}>
      {ROWS.map((segments) => {
        const lit = Math.round((pct / 100) * segments);
        const hot = Math.floor(segments * 0.8);
        return (
          <span key={segments} className={`lvl__row lvl__row--${segments}`}>
            {Array.from({ length: segments }, (_, index) => (
              <i
                key={index}
                data-on={index < lit ? "" : undefined}
                data-hot={index >= hot ? "" : undefined}
                data-edge={index === hot ? "" : undefined}
                style={{ "--i": index } as CSSProperties}
              />
            ))}
          </span>
        );
      })}
    </div>
  );
}
