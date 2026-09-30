"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconArrowLeft, IconArrowRight } from "../ds/icons";
import { keepThai } from "../ds/ThaiText";

/** Slider resolution. */
const SCALE = 1000;

export interface RailPlan {
  tier: string;
  name: string;
  /** Approximate cuts per month (lib/plans.ts APPROX_CUTS_PER_MONTH). */
  cuts: number;
}

/**
 * /pricing's plan rail: the seven cards on one horizontal track that snaps
 * card by card, with a "how many clips a month" picker that points at the
 * plan that fits.
 *
 * The fit is computed from lib/plans.ts only (the cheapest monthly plan
 * whose approximate count covers the number picked) and the footnote that
 * qualifies every count sits right under the picker. The free plan is a
 * one-off trial credit, not a monthly allowance, so it is never the answer.
 *
 * Without JavaScript the rail still scrolls (natively, with snap) and every
 * card is there; only the picker needs the script.
 */
export function PlanRail({
  plans,
  initial,
  footnote,
  freeNote,
  children,
}: {
  plans: readonly RailPlan[];
  initial: number;
  footnote: string;
  freeNote: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const max = plans.reduce((top, plan) => Math.max(top, plan.cuts), 1);
  // A log scale, so 4 and 9 clips are as far apart on the track as 45 and 90.
  const toPosition = (count: number) => Math.round((Math.log(Math.max(1, count)) / Math.log(max)) * SCALE);
  const toClips = (position: number) => Math.max(1, Math.round(Math.exp((position / SCALE) * Math.log(max))));
  const [position, setPosition] = useState(() => toPosition(initial));
  const [touched, setTouched] = useState(false);
  const sliderId = useId();
  const noteId = useId();
  const clips = toClips(position);
  const fit = plans.find((plan) => plan.cuts >= clips) ?? plans[plans.length - 1];

  // Mark the fitting card; bring it into view once the visitor has used the picker.
  useEffect(() => {
    const track = root.current?.querySelector<HTMLElement>("[data-rail-track]");
    if (!track) return;
    let target: HTMLElement | null = null;
    for (const card of track.querySelectorAll<HTMLElement>("[data-tier]")) {
      const match = card.dataset.tier === fit.tier;
      card.toggleAttribute("data-fit", match);
      if (match) target = card.closest<HTMLElement>("li") ?? card;
    }
    if (!touched || !target) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({ left: target.offsetLeft - track.offsetLeft - 8, behavior: still ? "auto" : "smooth" });
  }, [fit.tier, touched]);

  function step(direction: 1 | -1) {
    const track = root.current?.querySelector<HTMLElement>("[data-rail-track]");
    const card = track?.querySelector<HTMLElement>("li");
    if (!track || !card) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy({ left: direction * (card.offsetWidth + 14), behavior: still ? "auto" : "smooth" });
  }

  const percent = (position / SCALE) * 100;

  return (
    <div ref={root} className="plan-rail">
      <div className="plan-rail__bar">
        <div className="picker">
          <label className="picker__label" htmlFor={sliderId}>
            ใช้ประมาณกี่คลิปต่อเดือน
          </label>
          <div className="picker__row">
            {/* The track and its plan markers share one box, so a marker sits
                exactly where the playhead stops for that plan. */}
            <div className="picker__track">
              <input
                id={sliderId}
                className="picker__range"
                type="range"
                min={0}
                max={SCALE}
                step={1}
                value={position}
                aria-describedby={noteId}
                aria-valuetext={`ราว ${clips} คลิปต่อเดือน แพลนที่พอดีคือ ${fit.name}`}
                style={{ ["--fill" as string]: `${percent}%` }}
                onChange={(event) => {
                  setPosition(Number(event.target.value));
                  setTouched(true);
                }}
              />
              <div className="picker__ticks" aria-hidden="true">
                {plans.map((plan) => (
                  <span
                    key={plan.tier}
                    className={plan.tier === fit.tier ? "picker__tick picker__tick--on" : "picker__tick"}
                    style={{ ["--at" as string]: toPosition(plan.cuts) / SCALE }}
                  >
                    {plan.name}
                  </span>
                ))}
              </div>
            </div>
            <output className="picker__out" htmlFor={sliderId} aria-live="polite">
              <span className="num picker__num">{clips}</span>
              <span className="picker__unit">คลิป / เดือน</span>
              <span className="picker__arrow" aria-hidden="true">
                →
              </span>
              <span className="picker__plan">{fit.name}</span>
            </output>
          </div>
          <p className="picker__note" id={noteId}>
            {keepThai(footnote)}
          </p>
          <p className="picker__note">{keepThai(freeNote)}</p>
        </div>
      </div>
      {/* Beside the cards they move (hidden where every card is in view). */}
      <div className="plan-rail__nav">
        <button type="button" className="btn btn-secondary btn-icon" onClick={() => step(-1)} aria-label="แพลนก่อนหน้า">
          <IconArrowLeft />
        </button>
        <button type="button" className="btn btn-secondary btn-icon" onClick={() => step(1)} aria-label="แพลนถัดไป">
          <IconArrowRight />
        </button>
      </div>
      {children}
    </div>
  );
}
