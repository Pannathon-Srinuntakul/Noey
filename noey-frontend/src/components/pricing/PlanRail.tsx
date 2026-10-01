"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  CLIP_MINUTES,
  CUTS_ROUNDING,
  CUT_MODE_WORDS,
  DEFAULT_CLIP_MINUTES,
  DEFAULT_CUT_MODE,
  FOOTAGE_MINUTES,
  PLAN_COPY,
  SPEECH_FOOTAGE,
  TIERS,
  PRECISION_NAMES,
  clampClipMinutes,
  clipsBasis,
  clipsCaveats,
  cutModeName,
  cutsAt,
  fitTier,
  formatCount,
  hasHighPrecision,
  isTier,
  maxClipMinutes,
  modeHasPrecision,
  type CutMode,
  type Precision,
  type Tier,
} from "@/lib/plans";
import { IconArrowLeft, IconArrowRight, IconMinus, IconPlus } from "../ds/icons";
import { Waveform } from "../ds/Waveform";
import { keepThai } from "../ds/ThaiText";
import { minutesAt, minutesForKey } from "./clipTrack";
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
  /** The name in parts that are each kept whole (lib/modes.ts `nameParts`). */
  nameParts: readonly string[];
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
    "ถอดเสียงแล้วให้ AI อ่านทั้งคลิปและเกลาทีละไฮไลต์ จำนวนไฮไลต์รู้ได้หลังอ่านจบ ระบบจึงประเมินโควตาต่อคลิปของโหมดนี้เผื่อไว้ ใช้จริงอาจได้คลิปมากกว่าตัวเลขนี้",
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
 * each number; the words that change with the mode; a card's headline and
 * second line, pointed at the setting picked and at the other one; the notes
 * shown instead of a count (past the ตัดฉากเด่น footage ceiling, short of
 * budget for one clip this long, no ระดับละเอียด on the plan); and the
 * ระดับละเอียด counts — hidden whole, row and all, in a mode without it.
 */
function applyChoice(choice: Choice) {
  const { mode, minutes } = choice;
  const fine = modeHasPrecision(mode);
  const setting = settingOf(choice);
  const other: Precision = setting === "high" ? "standard" : "high";
  for (const scope of document.querySelectorAll<HTMLElement>("[data-cuts-slot]")) {
    scope.dataset.cutsPrecision = scope.dataset.cutsSlot === "primary" ? setting : other;
    if (scope.dataset.cutsSlot === "secondary") scope.hidden = !fine;
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-n], [data-cuts-when]")) {
    const scope = node.closest<HTMLElement>("[data-cuts-tier]");
    const tier = scope?.dataset.cutsTier;
    if (!scope || !tier || !isTier(tier)) continue;
    const precision: Precision = scope.dataset.cutsPrecision === "high" ? "high" : "standard";
    const count = cutsAt(tier, minutes, precision, mode);
    if (node.hasAttribute("data-cuts-n")) {
      if (count) node.textContent = formatCount(count);
      continue;
    }
    const state =
      precision === "high" && fine && !hasHighPrecision(tier) ? "none" : count === null ? "over" : count === 0 ? "short" : "fit";
    node.hidden = node.dataset.cutsWhen !== state;
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-cuts-precision="high"]:not([data-cuts-slot]), [data-cuts-row="high"]')) {
    node.hidden = !fine;
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-word]")) {
    node.textContent = cutsWordText(node.dataset.cutsWord as CutsWordKind, mode);
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-setting-word]")) {
    node.textContent = PRECISION_NAMES[other];
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-cuts-setting-tag]")) {
    node.hidden = setting !== "high";
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-clip-minutes]")) {
    node.textContent = String(minutes);
  }
}

/** Marks the plan the calculator answers with: its card and its table column. */
function markFit(tier: Tier | null) {
  for (const node of document.querySelectorAll<HTMLElement>("[data-plan-col], .plan--full[data-tier]")) {
    const plan = node.dataset.planCol ?? node.dataset.tier;
    node.toggleAttribute("data-fit", plan === tier);
  }
}

/** "00:05:00" — the editor's timecode for a whole number of minutes. */
const timecode = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;

/**
 * ตัดฉากเด่น's footage ceilings as markers on the ruler: one per distinct
 * ceiling, named by its plans ("ฟรี · Lite", "Starter", "Pro ขึ้นไป").
 */
const CEILINGS = [...new Set(TIERS.map((tier) => FOOTAGE_MINUTES[tier]))].map((minutes) => {
  const names = TIERS.filter((tier) => FOOTAGE_MINUTES[tier] === minutes).map((tier) => PLAN_COPY[tier].name);
  return { minutes, label: names.length > 2 ? `${names[0]} ขึ้นไป` : names.join(" · ") };
});

/**
 * The raw-clip length as the editor draws a clip — and set the way the editor
 * trims one: a ruler with timecodes, a lane, and the clip as a gold block as
 * long as the minutes set, on the scale of the mode's longest clip (30 or 120
 * minutes). Drag the clip's end (its trim handle) or press anywhere on the
 * track to move the end there; whole minutes, clamped to the mode's range.
 * The handle is the focusable control (role="slider", named by the field's
 * label); the −/+ field beside it stays for typing an exact number.
 *
 * In ตัดฉากเด่น the plans' footage ceilings sit on the lane as markers, and a
 * ceiling the clip runs past is crossed out (with a small tick as the end
 * crosses it); in the other modes the line under the lane says they take two
 * hours on every plan.
 */
function ClipTrack({
  minutes,
  mode,
  disabled,
  labelledBy,
  onChange,
}: {
  minutes: number;
  mode: CutMode;
  disabled: boolean;
  labelledBy: string;
  onChange: (minutes: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const longest = maxClipMinutes(mode);
  const marks = longest > 60 ? [0, 30, 60, 90, 120] : [0, 10, 20, 30];
  const share = Math.min(1, minutes / longest);
  // The timecode rides inside the block once the block can hold it.
  const inside = share >= 0.3;
  const ceilings = mode === "dub_first" ? CEILINGS : [];
  // The length before the last change, to tick a ceiling the end just crossed
  // (React's "information from previous renders" pattern; no tick on load).
  const [shown, setShown] = useState(minutes);
  const [from, setFrom] = useState(minutes);
  if (shown !== minutes) {
    setFrom(shown);
    setShown(minutes);
  }

  // A drag reports at most once a frame: the counts across the page follow
  // without a storm of renders.
  function report(next: number) {
    pending.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current !== null) onChange(pending.current);
      pending.current = null;
    });
  }

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function at(clientX: number) {
    const box = lane.current?.getBoundingClientRect();
    return box ? minutesAt(clientX - box.left, box.width, longest) : minutes;
  }

  return (
    <div
      className={longest > 60 ? "cliptrack cliptrack--long" : "cliptrack"}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      style={{ ["--w" as string]: share, ["--units" as string]: longest > 60 ? longest / 5 : longest }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        report(at(event.clientX));
        lane.current?.querySelector<HTMLElement>("[role=slider]")?.focus({ preventScroll: true });
      }}
      onPointerMove={(event) => {
        if (dragging) report(at(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
    >
      <div className="cliptrack__ruler" aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark} className="cliptrack__mark tc" style={{ ["--at" as string]: mark / longest }}>
            {timecode(mark)}
          </span>
        ))}
      </div>
      <div ref={lane} className="cliptrack__lane">
        <div className="cliptrack__clip" aria-hidden="true">
          <Waveform still bars={72} seed={11} className="cliptrack__wave" />
          {inside ? <span className="cliptrack__tc tc">{timecode(minutes)}</span> : null}
        </div>
        {inside ? null : (
          <span className="cliptrack__tc cliptrack__tc--out tc" aria-hidden="true" style={{ ["--at" as string]: share }}>
            {timecode(minutes)}
          </span>
        )}
        {ceilings.map((ceiling) => {
          const passed = minutes > ceiling.minutes;
          const crossed = from > ceiling.minutes !== passed;
          // Keyed on the side the end is on, so crossing replays the tick.
          return (
            <span
              key={`${ceiling.minutes}-${passed}`}
              className="cliptrack__cap"
              aria-hidden="true"
              data-passed={passed ? "" : undefined}
              data-crossed={crossed ? "" : undefined}
              style={{ ["--at" as string]: ceiling.minutes / longest }}
            />
          );
        })}
        <span
          className="cliptrack__handle"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={labelledBy}
          aria-valuemin={CLIP_MINUTES.min}
          aria-valuemax={longest}
          aria-valuenow={minutes}
          aria-valuetext={`${minutes} นาที`}
          aria-disabled={disabled || undefined}
          onKeyDown={(event) => {
            if (disabled) return;
            const next = minutesForKey(event.key, minutes, longest);
            if (next === null) return;
            event.preventDefault();
            if (next !== minutes) onChange(next);
          }}
        />
      </div>
      <div className="cliptrack__caps" aria-hidden="true">
        {ceilings.length ? (
          <>
            <span className="cliptrack__legend">เพดานฟุตเทจ</span>
            {ceilings.map((ceiling) => (
              <span
                key={ceiling.minutes}
                className="cliptrack__name"
                data-passed={minutes > ceiling.minutes ? "" : undefined}
                style={{ ["--at" as string]: ceiling.minutes / longest }}
              >
                {ceiling.label}
              </span>
            ))}
          </>
        ) : (
          <span className="cliptrack__legend">{`ทุกแพลนรับฟุตเทจได้ถึง ${SPEECH_FOOTAGE}`}</span>
        )}
      </div>
    </div>
  );
}

// False on the server and while hydrating, true once the page's script runs:
// the controls stay disabled until then, so nothing looks live while it is dead.
const noSubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

/**
 * /pricing's plan rail: the seven cards on one horizontal track that snaps
 * card by card, with the calculator above them. The visitor sets the mode
 * they cut in, how long their raw clips run and (in ตัดฉากเด่น) the setting,
 * then how many clips a month they need; the readout names the plan that fits.
 *
 * Every count comes from lib/plans.ts `cutsAt` for that choice — ตัดฉากเด่น,
 * 5 minutes, ระดับปกติ until the visitor changes it, which is what the server
 * HTML states — and the choice rewrites every marked count on the page: the
 * cards, the list under them and the comparison table. The answer is
 * lib/plans.ts `fitTier`, and it is the ONE answer on the page: its card and
 * table column carry the gold, the badge and the gold action. When no plan
 * covers the number asked for, the readout says so instead of pointing at the
 * largest plan.
 *
 * Without JavaScript the rail still scrolls (natively, with snap) and every
 * card shows its default count; the controls render disabled until the
 * script runs.
 */
export function PlanRail({
  plans,
  modes,
  initial,
  children,
}: {
  plans: readonly RailPlan[];
  modes: readonly RailMode[];
  initial: number;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const live = useHydrated();
  const [choice, setChoice] = useState<Choice>({
    mode: DEFAULT_CUT_MODE,
    minutes: DEFAULT_CLIP_MINUTES[DEFAULT_CUT_MODE],
    precision: "standard",
  });
  // Whether the visitor has set a length: until then each mode opens on its own.
  const [edited, setEdited] = useState(false);
  // What the length field shows while it is being typed in.
  const [draft, setDraft] = useState(String(DEFAULT_CLIP_MINUTES[DEFAULT_CUT_MODE]));
  const max = maxCuts(plans, choice);
  // The clips asked for; kept when the choice moves, so the answer follows it.
  const [wanted, setWanted] = useState(initial);
  const [position, setPosition] = useState(() => positionFor(initial, max));
  // Which ends of the rail are in view: an arrow that cannot move says so.
  const [edges, setEdges] = useState({ start: true, end: false });
  // The first time the fit is marked (on load) the rail jumps; later it glides.
  const placed = useRef(false);
  const modeGroup = useId();
  const settingGroup = useId();
  const sliderId = useId();
  const noteId = useId();
  const lengthId = useId();
  const lengthNoteId = useId();
  const lengthLabelId = useId();
  const setting = settingOf(choice);
  const counts = countsFor(plans, choice);
  const fit = fitTier(wanted, choice.minutes, choice.mode, setting);
  const fitPlan = plans.find((plan) => plan.tier === fit) ?? null;
  // The largest count on offer, for the readout when no plan covers the ask.
  const top = counts.reduce((best, plan) => ((plan.cuts ?? 0) > (best.cuts ?? 0) ? plan : best), counts[counts.length - 1]);
  const { unit } = CUT_MODE_WORDS[choice.mode];
  const fine = modeHasPrecision(choice.mode);
  const current = modes.find((mode) => mode.id === choice.mode) ?? modes[0];

  /**
   * Moves the choice and keeps the picker on the same number of clips. A new
   * mode opens on its own length unless the visitor has set one, which is
   * kept, pulled into the new mode's range.
   */
  function choose(next: Partial<Choice>, { lengthSet = false }: { lengthSet?: boolean } = {}) {
    const mode = next.mode ?? choice.mode;
    const asked = next.minutes ?? choice.minutes;
    const fresh = next.mode !== undefined && next.mode !== choice.mode && !edited && !lengthSet;
    const minutes = clampClipMinutes(fresh ? DEFAULT_CLIP_MINUTES[mode] : asked, mode);
    if (lengthSet) setEdited(true);
    if (minutes !== asked || next.mode !== undefined) setDraft(String(minutes));
    const updated = { mode, minutes, precision: next.precision ?? choice.precision };
    if (updated.mode === choice.mode && updated.minutes === choice.minutes && updated.precision === choice.precision) return;
    setChoice(updated);
    const nextMax = maxCuts(plans, updated);
    setPosition(positionFor(Math.min(wanted, nextMax), nextMax));
  }

  function commitLength(next: number) {
    const minutes = clampClipMinutes(next, choice.mode);
    setDraft(String(minutes));
    choose({ minutes }, { lengthSet: true });
  }

  useEffect(() => {
    applyChoice(choice);
  }, [choice]);

  // Mark the answer on its card and table column, and open the rail on its
  // card (phones and tablets, where the rail scrolls): a jump on load, a
  // glide after, never an animation under reduced motion.
  useEffect(() => {
    markFit(fit);
    const track = root.current?.querySelector<HTMLElement>("[data-rail-track]");
    const card = fit ? track?.querySelector<HTMLElement>(`[data-tier="${fit}"]`)?.closest<HTMLElement>("li") : null;
    const first = !placed.current;
    placed.current = true;
    if (!track || !card || track.scrollWidth <= track.clientWidth + 2) return;
    const still = first || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const inset = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    track.scrollTo({ left: card.offsetLeft - inset, behavior: still ? "auto" : "smooth" });
  }, [fit]);

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
  // The basis in two unbreakable halves: "คิดจากโหมด… (ระดับละเอียด)" and "คลิปดิบ N นาที".
  const basis = clipsBasis(choice.minutes, choice.mode, setting);
  const cut = basis.lastIndexOf(" คลิปดิบ ");
  const basisHead = basis.slice(0, cut);
  const basisTail = basis.slice(cut + 1);
  const answerText = fitPlan
    ? `แพลนที่พอดีคือ ${fitPlan.name}`
    : `เกินทุกแพลน ${top.name} ได้ราว ${formatCount(top.cuts ?? 0)} ${unit}`;

  return (
    <div ref={root} className="plan-rail">
      <div className="plan-rail__bar" data-idle={live ? undefined : ""}>
        {/* What every count below is priced on: the mode, the length, the
            setting. Native radios, so arrow keys move within each group. */}
        <fieldset className="mode-pick" disabled={!live}>
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
                    <span className="mode-pick__name">
                      {mode.nameParts.map((part, index) => (
                        <span key={part}>
                          {index ? <wbr /> : null}
                          <span className="kt">{part}</span>
                        </span>
                      ))}
                    </span>
                    <span className="mode-pick__fit">{keepThai(mode.fit)}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>
          {/* Phones show the modes as a row of chips; what the picked one is
              for is said once, under them. */}
          <p className="mode-pick__current">
            <span className="mode-pick__current-label">เหมาะกับ</span>
            {keepThai(current.fit)}
          </p>
        </fieldset>
        {/* The steppers are aria-disabled at an end rather than disabled, so a
            keyboard user who just pressed one keeps their focus. */}
        <div className="cliplen">
          <label className="picker__label" htmlFor={lengthId} id={lengthLabelId}>
            ความยาวคลิปดิบของคุณ
          </label>
          <div className="cliplen__body">
            <div className="cliplen__row">
              <button
                type="button"
                className="btn btn-secondary btn-icon cliplen__step"
                onClick={() => !atMin && commitLength(choice.minutes - 1)}
                disabled={!live}
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
                disabled={!live}
                aria-label="พิมพ์ความยาวคลิปดิบเป็นนาที"
                aria-describedby={lengthNoteId}
                onChange={(event) => {
                  const text = event.target.value;
                  setDraft(text);
                  const value = Number(text);
                  // Applied as typed when it is a length the page takes;
                  // anything else waits for the field to lose focus, then
                  // snaps into range.
                  if (text.trim() !== "" && Number.isInteger(value) && value >= CLIP_MINUTES.min && value <= longest) {
                    choose({ minutes: value }, { lengthSet: true });
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
                disabled={!live}
                aria-disabled={atMax || undefined}
                aria-controls={lengthId}
                aria-label="ยาวขึ้น 1 นาที"
              >
                <IconPlus />
              </button>
              <span className="cliplen__unit">นาที</span>
            </div>
            <ClipTrack
              minutes={choice.minutes}
              mode={choice.mode}
              disabled={!live}
              labelledBy={lengthLabelId}
              onChange={(minutes) => {
                setDraft(String(minutes));
                choose({ minutes }, { lengthSet: true });
              }}
            />
          </div>
          {/* The range, for the field: the track above draws it for the eye. */}
          <p className="sr-only" id={lengthNoteId}>
            {`ความยาวต่อคลิป ตั้งได้ ${CLIP_MINUTES.min}–${longest} นาที`}
          </p>
        </div>
        {/* ระดับละเอียด exists only in ตัดฉากเด่น. In the other modes a line
            saying so takes the group's place in the same cell, so nothing
            below moves. */}
        <div className="rail-setup__fine">
          <fieldset className="seg rail-setup__layer" disabled={!live || !fine} data-off={fine ? undefined : ""}>
            <legend className="picker__label">ความละเอียด</legend>
            <div className="seg__options">
              {settings.map((option) => (
                <label key={option} className="seg__option">
                  <input
                    className="seg__input"
                    type="radio"
                    name={settingGroup}
                    value={option}
                    checked={setting === option}
                    onChange={() => choose({ precision: option })}
                  />
                  <span className="seg__text">{PRECISION_NAMES[option]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="rail-setup__layer" data-off={fine ? "" : undefined}>
            <span className="picker__label">ความละเอียด</span>
            <p className="seg__none">{keepThai(NO_SETTING)}</p>
          </div>
        </div>
        {/* The answer, beside the choices it answers: the clips asked for and
            the plan that covers them, then the basis — said once here for
            every count on the page. */}
        <div className="rail-answer">
          <output className="picker__out" htmlFor={`${sliderId} ${lengthId}`} aria-live="polite">
            <span className="num picker__num">{formatCount(wanted)}</span>
            <span className="picker__unit">{`${unit} / เดือน`}</span>
            {fitPlan ? (
              <>
                <span className="picker__arrow" aria-hidden="true">
                  →
                </span>
                <span className="picker__plan">{fitPlan.name}</span>
              </>
            ) : (
              <span className="picker__over">
                <span className="kt">เกินทุกแพลน</span>
                {" · "}
                <span className="kt">{`${top.name} ได้ราว ${formatCount(top.cuts ?? 0)}`}</span>
              </span>
            )}
          </output>
          <p className="rail-answer__basis">
            <span className="kt">{basisHead}</span> <span className="kt">{basisTail}</span>
            <span className="kt">{`\u00a0· ${CUTS_ROUNDING}`}</span>
          </p>
        </div>
        <p className="picker__note rail-setup__note">{keepThai(MODE_NOTE[choice.mode])}</p>
        {/* Says what the counts are now priced on, once per change; the
            readout announces the answer. */}
        <p className="sr-only" aria-live="polite">
          {live ? `คิดใหม่ตามโหมด${cutModeName(choice.mode)} คลิปดิบ ${choice.minutes} นาที${setting === "high" ? " ระดับละเอียด" : ""}` : ""}
        </p>
        <div className="picker">
          <label className="picker__label" htmlFor={sliderId}>
            {`ใช้ประมาณกี่${unit}ต่อเดือน`}
          </label>
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
              disabled={!live}
              aria-describedby={noteId}
              aria-valuetext={`ราว ${formatCount(wanted)} ${unit}ต่อเดือน ${answerText}`}
              style={{ ["--fill" as string]: `${percent}%` }}
              onChange={(event) => {
                const next = Number(event.target.value);
                setPosition(next);
                setWanted(clipsFor(next, max));
              }}
            />
            <div className="picker__ticks" aria-hidden="true">
              {/* A plan with no count for this choice (past its ตัดฉากเด่น
                  footage ceiling, short of budget for one clip this long, or
                  without the setting) steps off the track. */}
              {counts.map((plan) => (
                <span
                  key={plan.tier}
                  className={["picker__tick", plan.tier === fit ? "picker__tick--on" : null, !plan.cuts ? "picker__tick--out" : null]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ ["--at" as string]: plan.cuts ? positionFor(plan.cuts, max) / SCALE : 0 }}
                >
                  {plan.name}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="picker__note picker__caveats" id={noteId}>
          {keepThai(clipsCaveats(choice.mode))}
        </p>
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
