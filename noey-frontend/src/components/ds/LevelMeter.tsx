import type { CSSProperties } from "react";
import { limitTone, overPct } from "@/lib/usage-limits";
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
 *
 * Past 100% (a quota window can end at e.g. 106% — the step in flight is
 * charged in full and the excess counts toward the next round) every segment
 * is lit and a clip light comes on at the meter's end, as an audio meter's
 * does when the signal goes over: "+6%". The meter keeps its height, so a
 * page drawn over a skeleton does not move.
 */
export function LevelMeter({
  value,
  labelledBy,
  className,
}: {
  /** 0–100; a quota window may pass 100 (the clip light then shows by how much). */
  value: number;
  labelledBy?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const over = overPct(value);
  const tone = limitTone(pct);
  const a11y = labelledBy
    ? {
        role: "progressbar" as const,
        "aria-labelledby": labelledBy,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(pct),
        // The true reading when it is past the bar's end.
        ...(over > 0 ? { "aria-valuetext": `${100 + over}%` } : null),
      }
    : { "aria-hidden": true as const };
  const meter = (
    <div className={["lvl", `lvl--${tone}`, over > 0 ? "lvl--over" : null, className].filter(Boolean).join(" ")} data-reveal="level" {...a11y}>
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
  if (over === 0) return meter;
  return (
    <div className="lvl-line">
      {meter}
      <span className="lvl__clip num" aria-hidden="true">{`+${over}%`}</span>
    </div>
  );
}
