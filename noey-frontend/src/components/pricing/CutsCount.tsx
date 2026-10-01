import type { ReactNode } from "react";
import {
  CLIP_MINUTES,
  CUT_MODE_WORDS,
  DEFAULT_CUT_MODE,
  cutModeName,
  type Precision,
  type Tier,
} from "@/lib/plans";

/**
 * Markers for the clip counts /pricing's calculator rewrites (PlanRail's
 * `applyChoice`). The server renders every one at the default — ตัดฉากเด่น,
 * 5 minutes — so the HTML a crawler or a visitor without JavaScript reads is
 * whole and states its basis; the calculator only swaps text in place.
 *
 *   [data-cuts-tier][data-cuts-precision]  one count's scope (hidden whole when
 *                                          the mode has no such setting)
 *   [data-cuts-slot="primary" | "secondary"]
 *                                          a card's headline and its second
 *                                          line: the calculator points the
 *                                          headline at the setting picked and
 *                                          the second line at the other one
 *   [data-cuts-setting-word]               "ละเอียด" / "ปกติ" in the second line
 *   [data-cuts-setting-tag]                "ระดับละเอียด" by the headline, shown
 *                                          only when that setting is picked
 *   [data-cuts-n]                          its number
 *   [data-cuts-when="fit" | "over" | "short" | "none"]
 *                                          its text; the ตัดฉากเด่น footage-ceiling
 *                                          note; the note for a clip that costs
 *                                          more than the plan's whole budget;
 *                                          the note for a plan without ระดับละเอียด
 *   [data-cuts-word]                       a word that changes with the mode
 *   [data-clip-minutes]                    the raw-clip length
 *
 * Elsewhere (the home page, the help page) nothing rewrites them.
 */

export type CutsWordKind = "hedge" | "prefix" | "unit" | "unit-month" | "mode";

/** A word that changes with the mode, by kind. */
export function cutsWordText(word: CutsWordKind, mode = DEFAULT_CUT_MODE): string {
  const { hedge, unit } = CUT_MODE_WORDS[mode];
  switch (word) {
    case "hedge":
      return hedge;
    case "prefix":
      // "ตัดได้ราว" (CUTS_APPROX_PREFIX) or "ตัดได้อย่างน้อย".
      return `ตัดได้${hedge}`;
    case "unit":
      return unit;
    case "unit-month":
      return `${unit} / เดือน`;
    case "mode":
      return cutModeName(mode);
  }
}

/**
 * One count's scope: its text, and the notes shown instead — past the plan's
 * ตัดฉากเด่น footage ceiling (`over`), where one clip of that length costs
 * more than the plan's whole budget (`short`), and where the headline is
 * asked for ระดับละเอียด on a plan without it (`none`).
 */
export function CutsCount({
  tier,
  precision = "standard",
  slot,
  over,
  short,
  none,
  className,
  children,
}: {
  tier: Tier;
  precision?: Precision;
  slot?: "primary" | "secondary";
  over?: ReactNode;
  short?: ReactNode;
  none?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={className} data-cuts-tier={tier} data-cuts-precision={precision} data-cuts-slot={slot}>
      <span data-cuts-when="fit">{children}</span>
      {over ? (
        <span data-cuts-when="over" hidden>
          {over}
        </span>
      ) : null}
      {short ? (
        <span data-cuts-when="short" hidden>
          {short}
        </span>
      ) : null}
      {none ? (
        <span data-cuts-when="none" hidden>
          {none}
        </span>
      ) : null}
    </span>
  );
}

/** The number inside a `CutsCount`. */
export function CutsNumber({ value, className }: { value: number; className?: string }) {
  return (
    <span className={className} data-cuts-n="">
      {value}
    </span>
  );
}

export function CutsWord({ word }: { word: CutsWordKind }) {
  return <span data-cuts-word={word}>{cutsWordText(word)}</span>;
}

/**
 * "คิดจากโหมดตัดฉากเด่น คลิปดิบ 5 นาที" (`CLIPS_BASIS_SHORT`), with the mode
 * and the length marked (the comparison table's note on /pricing).
 */
export function ClipsBasis() {
  return (
    <>
      <span className="kt">
        คิดจากโหมด
        <CutsWord word="mode" />
      </span>{" "}
      <span className="kt">
        คลิปดิบ <span data-clip-minutes="">{CLIP_MINUTES.basis}</span> นาที
      </span>
    </>
  );
}
