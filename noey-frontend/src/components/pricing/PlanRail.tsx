"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CLIP_MINUTES,
  CUT_MODE_WORDS,
  DEFAULT_CUT_MODE,
  PRECISION_NAMES,
  clampClipMinutes,
  clipsFootnote,
  maxClipMinutes,
  cutModeName,
  cutsAt,
  formatCount,
  isTier,
  modeHasPrecision,
  type CutMode,
  type Precision,
  type Tier,
} from "@/lib/plans";
import { IconArrowLeft, IconArrowRight, IconMinus, IconPlus } from "../ds/icons";
import { keepThai } from "../ds/ThaiText";
import { cutsWordText, type CutsWordKind } from "./CutsCount";

/** Slider resolution. */
const SCALE = 1000;

export interface RailPlan {
  tier: Tier;
  name: string;
}

/** A mode as the picker shows it: lib/modes.ts, with the editor's icon drawn on the server. */
export interface RailMode {
  id: CutMode;
  name: string;
  /** The footage it is for (lib/modes.ts `fit`). */
  fit: string;
  icon: ReactNode;
}

/** What the calculator prices: a mode, a raw-clip length, a setting. */
interface Choice {
  mode: CutMode;
  minutes: number;
  precision: Precision;
}

/**
 * What drives each mode's cost, in one line under the choices. Only claims
 * that hold at every length: ตัดช่วงเงียบ is the cheapest at any length, but
 * ตัดฉากเด่น and ตัดไฮไลต์จากคลิปยาว swap places as clips get longer, so
 * neither is called the dearer.
 */
const MODE_NOTE: Record<CutMode, string> = {
  talking_head: "ใช้แค่การถอดเสียง ไม่มีขั้นที่ AI ดูภาพหรืออ่านเนื้อหา จึงใช้โควตาน้อยที่สุดในสามโหมด",
  dub_first: "AI ดูฟุตเทจทุกวินาทีแล้วเขียนสคริปต์ ยิ่งคลิปยาว หรือเลือกระดับละเอียด (แพลน Pro ขึ้นไป) ยิ่งใช้โควตามาก",
  speech_highlights:
    "ถอดเสียงแล้วให้ AI อ่านทั้งคลิปและเกลาทีละไฮไลต์ จำนวนไฮไลต์รู้ได้หลังอ่านจบ ระบบจึงคิดเผื่อไว้สูงและบอกเป็นจำนวนขั้นต่ำ",
};

/** In place of the setting where the mode has none, so nothing below moves. */
const NO_SETTING = "โหมดนี้ไม่มีระดับละเอียด";

/** The setting a choice is priced at: ระดับละเอียด exists only in ตัดฉากเด่น. */
const settingOf = (choice: Choice): Precision => (modeHasPrecision(choice.mode) ? choice.precision : "standard");

const countsFor = (plans: readonly RailPlan[], choice: Choice) =>
  plans.map((plan) => ({ ...plan, cuts: cutsAt(plan.tier, choice.minutes, settingOf(choice), choice.mode) }));

/** The largest count among the plans for this choice: the scale's end. */
const maxCuts = (plans: readonly RailPlan[], choice: Choice) =>
  countsFor(plans, choice).reduce((top, plan) => Math.max(top, plan.cuts ?? 1), 2);

// A log scale, so 4 and 9 clips are as far apart on the track as 45 and 90.
const positionFor = (count: number, max: number) => Math.round((Math.log(Math.max(1, count)) / Math.log(max)) * SCALE);
const clipsFor = (position: number, max: number) => Math.max(1, Math.round(Math.exp((position / SCALE) * Math.log(max))));

/**
 * Rewrites every count the page marked (pricing/CutsCount) for this choice:
 * each number, the words that change with the mode, the footage-ceiling note
 * where the length is over a plan's ceiling, and the ระดับละเอียด counts —
 * hidden whole, row and all, in a mode that has no such setting.
 */
function applyChoice(choice: Choice) {
  const { mode, minutes } = choice;
  const fine = modeHasPrecision(mode);
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-n], [data-cuts-when]")) {
    const scope = node.closest<HTMLElement>("[data-cuts-tier]");
    const tier = scope?.dataset.cutsTier;
    if (!scope || !tier || !isTier(tier)) continue;
    const count = cutsAt(tier, minutes, scope.dataset.cutsPrecision === "high" ? "high" : "standard", mode);
    if (node.hasAttribute("data-cuts-n")) {
      if (count) node.textContent = formatCount(count);
    } else {
      const state = count === null ? "over" : count === 0 ? "short" : "fit";
      node.hidden = node.dataset.cutsWhen !== state;
    }
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-cuts-precision="high"], [data-cuts-row="high"]')) {
    node.hidden = !fine;
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-word]")) {
    node.textContent = cutsWordText(node.dataset.cutsWord as CutsWordKind, mode);
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-clip-minutes]")) {
    node.textContent = String(minutes);
  }
}

/**
 * /pricing's plan rail: the seven cards on one horizontal track that snaps
 * card by card, with the calculator above them. The visitor sets the mode
 * they cut in, how long their raw clips run and (in ตัดฉากเด่น) the setting,
 * then how many clips a month they need; the picker points at the plan that
 * fits.
 *
 * Every count comes from lib/plans.ts `cutsAt` for that choice — ตัดฉากเด่น,
 * 5 minutes, ระดับปกติ until the visitor changes it, which is what the server
 * HTML states — and the choice rewrites every marked count on the page: the
 * cards, the sentence under them and the comparison table. The fit is the
 * cheapest monthly plan whose count covers the number picked and whose
 * footage ceiling takes the length. The free plan is a one-off trial credit,
 * not a monthly allowance, so it is never the answer.
 *
 * Without JavaScript the rail still scrolls (natively, with snap) and every
 * card shows its default count; only the controls need the script.
 */
export function PlanRail({
  plans,
  modes,
  initial,
  freeNote,
  children,
}: {
  plans: readonly RailPlan[];
  modes: readonly RailMode[];
  initial: number;
  freeNote: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<Choice>({ mode: DEFAULT_CUT_MODE, minutes: CLIP_MINUTES.basis, precision: "standard" });
  // What the length field shows while it is being typed in.
  const [draft, setDraft] = useState(String(CLIP_MINUTES.basis));
  const max = maxCuts(plans, choice);
  // The clips asked for; kept when the choice moves, so the answer follows it.
  const [wanted, setWanted] = useState(initial);
  const [position, setPosition] = useState(() => positionFor(initial, max));
  const [touched, setTouched] = useState(false);
  // Which ends of the rail are in view: an arrow that cannot move says so.
  const [edges, setEdges] = useState({ start: true, end: false });
  const modeGroup = useId();
  const settingGroup = useId();
  const sliderId = useId();
  const noteId = useId();
  const lengthId = useId();
  const lengthNoteId = useId();
  const counts = countsFor(plans, choice);
  const clips = Math.min(wanted, max);
  const fit = counts.find((plan) => plan.cuts !== null && plan.cuts > 0 && plan.cuts >= clips) ?? counts[counts.length - 1];
  const { unit } = CUT_MODE_WORDS[choice.mode];
  const fine = modeHasPrecision(choice.mode);

  /** Moves the choice and keeps the picker on the same number of clips. */
  function choose(next: Partial<Choice>) {
    const merged = { ...choice, ...next };
    // A mode with a shorter range pulls the length into it.
    const updated = { ...merged, minutes: clampClipMinutes(merged.minutes, merged.mode) };
    if (updated.minutes !== merged.minutes || next.mode) setDraft(String(updated.minutes));
    if (updated.mode === choice.mode && updated.minutes === choice.minutes && updated.precision === choice.precision) return;
    setChoice(updated);
    const nextMax = maxCuts(plans, updated);
    setPosition(positionFor(Math.min(wanted, nextMax), nextMax));
    setTouched(true);
  }

  function commitLength(next: number) {
    const minutes = clampClipMinutes(next, choice.mode);
    setDraft(String(minutes));
    choose({ minutes });
  }

  useEffect(() => {
    applyChoice(choice);
  }, [choice]);

  // Mark the fitting card and its column in the comparison table; bring the
  // card into view once the visitor has used a control.
  useEffect(() => {
    for (const cell of document.querySelectorAll<HTMLElement>("[data-plan-col]")) {
      cell.toggleAttribute("data-fit", cell.dataset.planCol === fit.tier);
    }
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

  useEffect(() => {
    const track = root.current?.querySelector<HTMLElement>("[data-rail-track]");
    if (!track) return;
    const update = () => {
      const start = track.scrollLeft <= 2;
      const end = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
      setEdges((last) => (last.start === start && last.end === end ? last : { start, end }));
    };
    update();
    track.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(track);
    return () => {
      track.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, []);

  function step(direction: 1 | -1) {
    const track = root.current?.querySelector<HTMLElement>("[data-rail-track]");
    const card = track?.querySelector<HTMLElement>("li");
    if (!track || !card) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy({ left: direction * (card.offsetWidth + 14), behavior: still ? "auto" : "smooth" });
  }

  const percent = (position / SCALE) * 100;
  const atMin = choice.minutes <= CLIP_MINUTES.min;
  const longest = maxClipMinutes(choice.mode);
  const atMax = choice.minutes >= longest;
  const settings: readonly Precision[] = ["standard", "high"];

  return (
    <div ref={root} className="plan-rail">
      <div className="plan-rail__bar">
        {/* What every count below is priced on: the mode, the length, the
            setting. Native radios, so arrow keys move within each group. */}
        <div className="rail-setup">
          <fieldset className="mode-pick">
            <legend className="picker__label">โหมดที่ใช้</legend>
            <div className="mode-pick__options">
              {modes.map((mode) => (
                <label key={mode.id} className="mode-pick__option">
                  <input
                    className="mode-pick__input"
                    type="radio"
                    name={modeGroup}
                    value={mode.id}
                    checked={choice.mode === mode.id}
                    onChange={() => choose({ mode: mode.id })}
                  />
                  <span className="mode-pick__face">
                    <span className="mode-pick__icon" aria-hidden="true">
                      {mode.icon}
                    </span>
                    <span className="mode-pick__text">
                      <span className="mode-pick__name">{keepThai(mode.name)}</span>
                      <span className="mode-pick__fit">{keepThai(mode.fit)}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="rail-setup__row">
            {/* The steppers are aria-disabled at an end rather than disabled,
                so a keyboard user who just pressed one keeps their focus. */}
            <div className="cliplen">
              <label className="picker__label" htmlFor={lengthId}>
                ความยาวคลิปดิบของคุณ
              </label>
              <div className="cliplen__row">
                <button
                  type="button"
                  className="btn btn-secondary btn-icon cliplen__step"
                  onClick={() => !atMin && commitLength(choice.minutes - 1)}
                  aria-disabled={atMin || undefined}
                  aria-controls={lengthId}
                  aria-label="สั้นลง 1 นาที"
                >
                  <IconMinus />
                </button>
                <input
                  id={lengthId}
                  className="input num cliplen__input"
                  type="number"
                  inputMode="numeric"
                  min={CLIP_MINUTES.min}
                  max={longest}
                  step={1}
                  value={draft}
                  aria-describedby={lengthNoteId}
                  onChange={(event) => {
                    const text = event.target.value;
                    setDraft(text);
                    const value = Number(text);
                    // Applied as typed when it is a length the page takes;
                    // anything else waits for the field to lose focus, then
                    // snaps into range.
                    if (text.trim() !== "" && Number.isInteger(value) && value >= CLIP_MINUTES.min && value <= longest) {
                      choose({ minutes: value });
                    }
                  }}
                  onBlur={() => commitLength(draft.trim() === "" ? choice.minutes : Number(draft))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitLength(draft.trim() === "" ? choice.minutes : Number(draft));
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-icon cliplen__step"
                  onClick={() => !atMax && commitLength(choice.minutes + 1)}
                  aria-disabled={atMax || undefined}
                  aria-controls={lengthId}
                  aria-label="ยาวขึ้น 1 นาที"
                >
                  <IconPlus />
                </button>
                <span className="cliplen__unit">นาที</span>
              </div>
              <p className="picker__note" id={lengthNoteId}>
                {keepThai(`ความยาวต่อคลิป ตั้งได้ ${CLIP_MINUTES.min}–${longest} นาที`)}
              </p>
            </div>
            {/* ระดับละเอียด exists only in ตัดฉากเด่น. In the other modes a
                line saying so takes the group's place in the same cell, so
                nothing below moves. */}
            <div className="rail-setup__fine">
              <fieldset className="seg rail-setup__layer" disabled={!fine} data-off={fine ? undefined : ""}>
                <legend className="picker__label">ความละเอียด</legend>
                <div className="seg__options">
                  {settings.map((setting) => (
                    <label key={setting} className="seg__option">
                      <input
                        className="seg__input"
                        type="radio"
                        name={settingGroup}
                        value={setting}
                        checked={settingOf(choice) === setting}
                        onChange={() => choose({ precision: setting })}
                      />
                      <span className="seg__text">{PRECISION_NAMES[setting]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="rail-setup__layer" data-off={fine ? "" : undefined}>
                <span className="picker__label">ความละเอียด</span>
                <p className="seg__none">{keepThai(NO_SETTING)}</p>
              </div>
            </div>
          </div>
        </div>
        <p className="picker__note rail-setup__note">{keepThai(MODE_NOTE[choice.mode])}</p>
        {/* Says what the counts are now priced on, once per change; the
            readout below announces the plan. */}
        <p className="sr-only" aria-live="polite">
          {`คิดใหม่ตามโหมด${cutModeName(choice.mode)} คลิปดิบ ${choice.minutes} นาที${fine && choice.precision === "high" ? " ระดับละเอียด" : ""}`}
        </p>
        <div className="picker">
          <label className="picker__label" htmlFor={sliderId}>
            {`ใช้ประมาณกี่${unit}ต่อเดือน`}
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
                aria-valuetext={`ราว ${formatCount(clips)} ${unit}ต่อเดือน แพลนที่พอดีคือ ${fit.name}`}
                style={{ ["--fill" as string]: `${percent}%` }}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPosition(next);
                  setWanted(clipsFor(next, max));
                  setTouched(true);
                }}
              />
              <div className="picker__ticks" aria-hidden="true">
                {/* A plan with no count for this choice (past its ตัดฉากเด่น
                    footage ceiling, short of budget for one clip this long,
                    or without the setting) steps off the track. */}
                {counts.map((plan) => (
                  <span
                    key={plan.tier}
                    className={["picker__tick", plan.tier === fit.tier ? "picker__tick--on" : null, !plan.cuts ? "picker__tick--out" : null]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ ["--at" as string]: plan.cuts ? positionFor(plan.cuts, max) / SCALE : 0 }}
                  >
                    {plan.name}
                  </span>
                ))}
              </div>
            </div>
            <output className="picker__out" htmlFor={sliderId} aria-live="polite">
              <span className="num picker__num">{formatCount(clips)}</span>
              <span className="picker__unit">{`${unit} / เดือน`}</span>
              <span className="picker__arrow" aria-hidden="true">
                →
              </span>
              <span className="picker__plan">{fit.name}</span>
            </output>
          </div>
          <p className="picker__note" id={noteId}>
            {keepThai(clipsFootnote(choice.minutes, choice.mode))}
          </p>
          <p className="picker__note">{keepThai(freeNote)}</p>
        </div>
      </div>
      {/* Beside the cards they move (hidden where every card is in view). At
          an end the arrow is aria-disabled rather than disabled, so a keyboard
          user who just pressed it keeps their focus on it. */}
      <div className="plan-rail__nav">
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          onClick={() => !edges.start && step(-1)}
          aria-disabled={edges.start || undefined}
          aria-label="แพลนก่อนหน้า"
        >
          <IconArrowLeft />
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          onClick={() => !edges.end && step(1)}
          aria-disabled={edges.end || undefined}
          aria-label="แพลนถัดไป"
        >
          <IconArrowRight />
        </button>
      </div>
      {children}
    </div>
  );
}
