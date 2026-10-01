import type { ReactNode } from "react";
import { SAMPLE_CLIPS, SAMPLE_PROJECT, SAMPLE_SOURCE_SECONDS, clipTile } from "../sample";
import { Button, ChoiceTrigger, Icon, InputBox, Omit, Segmented, SwitchMark, TextareaBox, Tile, TitleBar, cn } from "./ui";

/**
 * The create wizard (web/src/pages/WizardPage.tsx and components/wizard/*) on
 * the web build, filled in for the sample project: five clips, then
 * ตัดฉากเด่น · ให้ AI ร่างสคริปต์ · 15 วิ with captions on, then the review.
 *
 * The data-am-* attributes mark what the hero's choreography animates (rows
 * dropping in, a card being picked, a button pressed); without it every screen
 * shows its settled state. Helper lines and secondary buttons are left out in
 * place (Omit).
 */

/** lib/wizardState.fmtClock. */
export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};

/** What the user typed as context before picking the mode (the note is shared by both modes). */
export const SAMPLE_NOTE = "รีวิวเซรั่ม เน้นเนื้อบางเบา ปิดท้ายชวนกดตะกร้า";

const STEP_NAMES = ["เลือกไฟล์", "เลือกผลลัพธ์", "ตรวจแล้วเริ่ม"];
/** WizardPage STEP_TITLES. */
const STEP_TITLES = ["เอาคลิปดิบมาจากไหน", "อยากได้วิดีโอแบบไหน", "ตรวจอีกครั้งแล้วเริ่มเลย"];

function StepRail({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-3.5 text-sm">
      {[1, 2, 3].map((n, i) => (
        <span key={n} className="flex items-center gap-3.5">
          {i > 0 ? <span className={cn("h-px w-10", n <= current ? "bg-accent" : "bg-[rgb(243_242_242_/_0.18)]")} /> : null}
          <span className={cn("inline-flex items-center gap-[7px]", n === current ? "font-semibold text-ink" : "text-muted")}>
            {n < current ? <Icon name="Check" size={14} strokeWidth={2.2} className="text-accent" /> : null}
            {n} · {STEP_NAMES[n - 1]}
          </span>
        </span>
      ))}
    </div>
  );
}

/** AppShell without the nav rail (the wizard is full-bleed), the step header, the body, the footer. */
function WizardFrame({ step, children, footer }: { step: number; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-ground">
      <TitleBar label="สร้างวิดีโอใหม่" />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-col gap-3.5 border-b border-divider px-5 pb-5 pt-8 md:px-10">
            <StepRail current={step} />
            <div>
              <p className="text-2xl font-semibold leading-[1.2] text-ink">{STEP_TITLES[step - 1]}</p>
              {step > 1 ? <p className="mt-1 text-sm tabular-nums text-muted">{`${SAMPLE_CLIPS.length} ไฟล์ · รวม ${fmtClock(SAMPLE_SOURCE_SECONDS)}`}</p> : null}
            </div>
          </div>
          {children}
          {footer}
        </main>
      </div>
    </div>
  );
}

function Footer({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-[18px] md:flex-nowrap md:gap-4 md:px-10">
      <Omit>
        <span className="min-w-0 truncate text-sm text-muted">{hint}</span>
      </Omit>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}

/** wizard/UsageEstimate.tsx. */
function Estimate() {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 text-[13px] leading-[1.6] tabular-nums text-ink-2">
        <Icon name="Gauge" size={15} className="mt-[3px] shrink-0" />
        งานนี้ใช้ประมาณ 5% ของโควตารายสัปดาห์
      </p>
    </div>
  );
}

// ─── Step 1 ──────────────────────────────────────────────────────────────────

/** When the first dropped row lands, and the gap to the next (seconds) — hero.css keeps the same numbers. */
const ROW_AT = 1.5;
const ROW_STEP = 0.16;

const clipMeta = (clip: (typeof SAMPLE_CLIPS)[number]) => `${fmtClock(clip.seconds)} · 1080×1920 · ${clip.megabytes} MB`;

/** WizardStepFiles + ClipList with the five sample clips. `animated` adds the drop-in states. */
export function WizardFiles({ animated = false }: { animated?: boolean }) {
  const total = SAMPLE_CLIPS.length;
  return (
    <WizardFrame
      step={1}
      footer={
        <Footer hint="คลิปจะถูกเก็บไว้ในบัญชีของคุณ เปิดต่อจากเครื่องไหนก็ได้ · กด Esc เพื่อยกเลิก">
          <Omit>
            <Button variant="ghost">ยกเลิก</Button>
          </Omit>
          {animated ? (
            <span className="am-swap" data-am="next">
              <span className="am-swap__a">
                <Button variant="primary" icon={<Icon name="ArrowRight" size={16} />} disabled reason={<Omit>เลือกคลิปอย่างน้อย 1 ไฟล์</Omit>}>
                  ถัดไป
                </Button>
              </span>
              <span className="am-swap__b">
                <Button variant="primary" icon={<Icon name="ArrowRight" size={16} />} data-am-target="next">
                  ถัดไป
                </Button>
              </span>
            </span>
          ) : (
            <Button variant="primary" icon={<Icon name="ArrowRight" size={16} />}>
              ถัดไป
            </Button>
          )}
        </Footer>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-6 lg:flex-row lg:overflow-hidden lg:px-10">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <span className="relative flex h-[200px] shrink-0 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[rgb(217_164_65_/_0.5)] bg-[rgb(217_164_65_/_0.05)]" data-am="drop" data-am-target="drop">
            {animated ? <span className="am-dragover absolute -inset-px rounded-md border border-accent bg-accent-tint" /> : null}
            <Icon name="Upload" size={30} strokeWidth={1.6} className="relative text-accent" />
            <span className="relative text-[17px] font-semibold text-ink">ลากไฟล์มาวางที่นี่</span>
            <span className="relative inline-flex h-10 items-center rounded-md border border-border px-4 text-[15px] font-semibold text-ink">
              เลือกไฟล์จากเครื่อง
            </span>
          </span>
          <span className="flex h-12 shrink-0 items-center justify-center gap-2.5 rounded-md border border-border text-[15px] font-semibold text-ink">
            <Icon name="Smartphone" size={17} className="text-accent" />
            รับวิดีโอจากมือถือ
          </span>
        </div>
        <div className="flex w-full shrink-0 flex-col overflow-hidden rounded-md border border-divider lg:w-[440px]">
          <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-divider px-5 py-4">
            <p className="text-[15px] font-semibold text-ink">ไฟล์ที่เลือกไว้</p>
            {animated ? (
              <span className="am-count text-sm tabular-nums text-muted">
                {Array.from({ length: total + 1 }, (_, n) => (
                  <span key={n} className="am-count__n" style={{ "--in": `${n === 0 ? 0 : ROW_AT + (n - 1) * ROW_STEP}s`, "--out": `${ROW_AT + n * ROW_STEP}s` } as React.CSSProperties}>
                    {n} ไฟล์{n > 0 ? ` · รวม ${fmtClock(SAMPLE_CLIPS.slice(0, n).reduce((s, c) => s + c.seconds, 0))} / 2:00:00` : ""}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-sm tabular-nums text-muted">{`${total} ไฟล์ · รวม ${fmtClock(SAMPLE_SOURCE_SECONDS)} / 2:00:00`}</span>
            )}
          </div>
          <div className={cn("shrink-0 border-b border-divider px-5 py-3", animated && "am-estimate")}>
            <Estimate />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ul>
              {SAMPLE_CLIPS.map((clip, i) => {
                const edge = i === 0 || i === total - 1;
                return (
                  <li
                    key={clip.file}
                    className={cn("flex flex-wrap items-center gap-2.5 border-b border-divider px-3 py-3 sm:flex-nowrap sm:px-5", animated && "am-row")}
                    style={animated ? ({ "--i": i } as React.CSSProperties) : undefined}
                  >
                    <span className="w-5 shrink-0 text-muted">
                      <Icon name="GripVertical" size={15} />
                    </span>
                    <span className="relative h-16 w-9 shrink-0 overflow-hidden rounded-[3px] bg-media">
                      <Tile index={clipTile(i)} className="h-full w-full" />
                      {animated ? (
                        <span className="am-decoding absolute inset-0 flex items-center justify-center bg-media">
                          <Icon name="Loader2" size={13} className="am-spin text-accent" />
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="block truncate text-[15px] text-ink">{clip.file}</span>
                      <span className={cn("block text-[13px] tabular-nums text-muted", animated && "am-stack")}>
                        {animated ? (
                          <>
                            <span className="am-meta-probe">กำลังอ่านข้อมูลคลิป…</span>
                            <span className="am-meta">{clipMeta(clip)}</span>
                          </>
                        ) : (
                          clipMeta(clip)
                        )}
                      </span>
                    </span>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted">
                      <Icon name="X" size={16} />
                    </span>
                    <div className="relative shrink-0">
                      <span
                        className={cn(
                          "inline-flex h-7 items-center rounded-md px-2.5 text-[13px]",
                          edge ? "border border-accent bg-accent-tint text-accent" : "border border-border text-muted",
                        )}
                      >
                        {i === 0 ? "คลิปเปิด" : i === total - 1 ? "คลิปปิด" : "กลางคลิป"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-1 items-center justify-center p-5">
              <p className={cn("text-center text-sm leading-[1.6] text-muted", animated && "am-stack")}>
                {animated ? (
                  <>
                    <span className="am-empty">ยังไม่ได้เลือกไฟล์ — ลากมาวางทางซ้าย</span>
                    <span className="am-filled">
                      <Omit>ลากที่จุดหกจุดเพื่อเรียงลำดับ · แตะป้ายเพื่อกำหนดคลิปเปิด–คลิปปิด</Omit>
                    </span>
                  </>
                ) : (
                  <Omit>ลากที่จุดหกจุดเพื่อเรียงลำดับ · แตะป้ายเพื่อกำหนดคลิปเปิด–คลิปปิด</Omit>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    </WizardFrame>
  );
}

// ─── Step 2 ──────────────────────────────────────────────────────────────────

const MODE_CARDS = [
  { key: "silence", icon: "Mic", title: "ตัดช่วงเงียบ", blurb: "คลิปพูดหน้ากล้อง ตัดช่วงเงียบออก คงเสียงเดิม ได้ซับจากเสียงพูด" },
  {
    key: "highlight",
    icon: "Clapperboard",
    title: "ตัดฉากเด่น",
    blurb: "คลิปขายของสำหรับปักตะกร้า AI เลือกช็อตโชว์สินค้าเด่นจากหลายคลิป พร้อมสคริปต์ขาย เลือกได้ว่าจะพากย์หรือใส่เพลง",
  },
  { key: "longform", icon: "Layers", title: "ตัดไฮไลต์จากคลิปยาว", blurb: "AI ฟังคำพูดในคลิปยาว แล้วตัดช่วงเด่นออกมาเป็นคลิปสั้นหลายคลิป เสียงเดิมทั้งหมด", badge: "ได้หลายคลิป" },
] as const;

/** A mode card — a <button>, so a card shorter than its row centres its content. */
function ModeCard({ card, selected }: { card: (typeof MODE_CARDS)[number]; selected: boolean }) {
  return (
    <div
      className={cn("relative flex flex-col justify-center rounded-md border p-[18px] text-left", selected ? "border-accent bg-accent-tint" : "border-border-faint")}
      data-am-target={card.key === "highlight" ? "mode" : undefined}
    >
      {selected ? <Icon name="Check" size={18} strokeWidth={2.2} className="absolute right-4 top-4 text-accent" /> : null}
      <div>
        <Icon name={card.icon} size={20} strokeWidth={1.7} className={selected ? "text-accent" : "text-muted"} />
        <p className="mt-2.5 text-[17px] font-semibold text-ink">
          {card.title}
          {"badge" in card ? (
            <span className="ml-2 inline-flex h-[22px] items-center rounded-[4px] border border-[rgb(217_164_65_/_0.55)] px-1.5 align-middle text-[12px] font-normal text-accent">{card.badge}</span>
          ) : null}
        </p>
        <p className={cn("mt-1.5 text-[15px] leading-[1.6]", selected ? "text-ink-2" : "text-muted")}>
          {card.blurb}
        </p>
      </div>
    </div>
  );
}

function Row({ label, hint, first, align = "center", children }: { label: string; hint?: string; first?: boolean; align?: "center" | "top"; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2 px-[18px] lg:flex-row lg:gap-5", first ? "" : "border-t border-divider", align === "center" ? "py-[11px] lg:items-center" : "py-[13px]")}>
      <div className={cn("w-full shrink-0 lg:w-[132px]", align === "top" && "lg:pt-[2px]")}>
        <p className="text-sm text-ink-2">{label}</p>
        {hint ? <p className="mt-[3px] text-[12.5px] text-muted">{hint}</p> : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const NOTE_SILENCE = ["ดูทุกคลิปแล้วแก้คำที่ถอดเสียงผิด", "ตัดช่วงพูดติดหรือพูดซ้ำออก", "เก็บช่วงเงียบที่ยังมีภาพสำคัญไว้"];
// The editor prints this note, but the pipeline cuts pauses only — it does not
// find a stumble or a sentence said twice (owner, 2026-10-01). The site does not
// repeat the claim: the line keeps its place in the drawing, unpainted.
const NOTE_NOT_DRAWN = "ตัดช่วงพูดติดหรือพูดซ้ำออก";

function SilenceRows() {
  return (
    <>
      <Row label="บริบท / ชื่อสินค้า" hint="ไม่บังคับ" align="top" first>
        <TextareaBox rows={2} value={SAMPLE_NOTE} />
        <p className="mt-[7px] text-[13px] text-muted">ช่วยให้ AI สะกดชื่อแบรนด์ถูกตอนถอดเสียง</p>
      </Row>
      <Row label="โหมดนี้ทำอะไร" align="top">
        <div className="flex flex-col gap-[7px] text-sm leading-[1.6] text-muted">
          {NOTE_SILENCE.map((note) =>
            note === NOTE_NOT_DRAWN ? (
              <Omit key={note}>
                <span className="flex gap-[9px]">
                  <span className="opacity-70">·</span>
                  {note}
                </span>
              </Omit>
            ) : (
              <span key={note} className="flex gap-[9px]">
                <span className="opacity-70">·</span>
                {note}
              </span>
            ),
          )}
        </div>
      </Row>
    </>
  );
}

const DURATIONS = [
  { value: "15", label: "15 วิ" },
  { value: "30", label: "30 วิ" },
  { value: "60", label: "60 วิ" },
  { value: "90", label: "90 วิ" },
  { value: "custom", label: "กำหนดเอง" },
];

function HighlightRows({ length, animated }: { length: string | null; animated: boolean }) {
  return (
    <>
      <Row label="เสียง" first>
        <Segmented
          value="ai"
          options={[
            { value: "ai", label: "ให้ AI ร่างสคริปต์" },
            { value: "own", label: "พิมพ์เอง" },
            { value: "none", label: "ไม่พากย์" },
          ]}
        />
        <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">โหมดนี้ไม่ใช้เสียงในคลิปเลย — ได้คลิปที่ตัดภาพไว้ให้ แล้วนำไปพากย์เสียงเองภายหลัง</p>
      </Row>
      <Row label="ความยาว">
        <div className="flex flex-wrap items-center gap-3">
          {animated ? (
            <span className="am-swap am-swap--inline" data-am="length">
              <span className="am-swap__a">
                <Segmented value={null} numeric options={DURATIONS} optionData={{ "15": { "data-am-target": "length" } }} />
              </span>
              <span className="am-swap__b">
                <Segmented value="15" numeric options={DURATIONS} />
              </span>
            </span>
          ) : (
            <Segmented value={length} numeric options={DURATIONS} />
          )}
          <div className="flex items-center gap-3">
            <span className="mx-0.5 h-5 w-px bg-border-faint" />
            <span className="flex h-[34px] items-center rounded-md border border-border-faint px-[13px] text-sm text-ink-2">ให้ AI เลือก</span>
            {/* Drawn as the app shows it: its disabled classes lose to the base ones there. */}
            <span className="flex h-[34px] items-center rounded-md border border-border-faint px-[13px] text-sm text-ink-2">ตามความยาวเพลง</span>
            <span className="text-[13px] text-muted">เลือกเพลงก่อน</span>
          </div>
        </div>
      </Row>
      <Row label="โมเดล" hint="ตัวไหนเป็นคนตัด">
        <ChoiceTrigger label="Director" />
        <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">
          ไล่ดูฟุตเทจทั้งม้วนแล้วเทียบทุกเทคก่อนตัดสินใจ ได้ช็อตกว้างกว่าและสำรองเยอะกว่า — คิดนานกว่าและใช้โควตามากกว่าราว 1.3 เท่า
        </p>
      </Row>
      <Row label="ความละเอียด" hint="AI ดูคลิปถี่แค่ไหน">
        <ChoiceTrigger label="ปกติ" />
        <p className="mt-[7px] text-[13px] leading-[1.55] text-[#8a8681]">ดูคลิปแบบห่าง ๆ พอเห็นว่าแต่ละช่วงเป็นอะไร เหมาะกับงานทั่วไป</p>
      </Row>
      <Row label="เพลงประกอบ">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value="none"
            options={[
              { value: "none", label: "ไม่ใส่" },
              {
                value: "pick",
                label: (
                  <>
                    <Icon name="Music2" size={14} /> เลือกไฟล์เพลง
                  </>
                ),
              },
            ]}
          />
        </div>
      </Row>
      <Row label="เล่าให้ AI ฟัง" hint="ไม่บังคับ" align="top">
        <TextareaBox rows={2} value={SAMPLE_NOTE} />
      </Row>
    </>
  );
}

/**
 * WizardStepOutcome. `mode` picks the selected card and its rows; `animated`
 * stacks both (ตัดช่วงเงียบ, the web default, then ตัดฉากเด่น) for the
 * choreography to switch between.
 */
export function WizardOutcome({ mode = "highlight", length = "15", animated = false }: { mode?: "silence" | "highlight"; length?: string | null; animated?: boolean }) {
  const cards = (selected: string) => (
    <div className="grid shrink-0 grid-cols-1 gap-4 md:grid-cols-3">
      {MODE_CARDS.map((card) => (
        <ModeCard key={card.key} card={card} selected={card.key === selected} />
      ))}
    </div>
  );
  const advanced = (
    <div className="shrink-0 rounded-md border border-divider">
      <span className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
        <span className="flex items-center gap-2 text-[15px] text-ink">
          <Icon name="ChevronDown" size={16} className="-rotate-90 text-muted" />
          ตั้งค่าเพิ่มเติม
          <span className="text-muted">— คำบรรยาย · การแยกโปรเจกต์</span>
        </span>
        <Omit>
          <span className="text-sm text-muted">ซ่อน</span>
        </Omit>
      </span>
      <div className="flex flex-col gap-5 border-t border-divider px-5 py-5">
        <div>
          <div className="flex items-center gap-3">
            <SwitchMark on label="ใส่คำบรรยาย" />
          </div>
        </div>
      </div>
    </div>
  );
  const body = (selected: "silence" | "highlight") => (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6 md:px-10">
      {cards(selected)}
      <div className="flex shrink-0 flex-col rounded-md border border-border-faint">{selected === "highlight" ? <HighlightRows length={length} animated={animated} /> : <SilenceRows />}</div>
      {advanced}
    </div>
  );
  return (
    <WizardFrame
      step={2}
      footer={
        <Footer hint="กด Esc เพื่อยกเลิก">
          <Omit>
            <Button icon={<Icon name="ArrowLeft" size={16} />}>ย้อนกลับ</Button>
          </Omit>
          <Button variant="primary" icon={<Icon name="ArrowRight" size={16} />} data-am-target="next">
            ถัดไป
          </Button>
        </Footer>
      }
    >
      {animated ? (
        <div className="am-swap am-swap--fill" data-am="mode">
          <div className="am-swap__a flex min-h-0 flex-1 flex-col">{body("silence")}</div>
          <div className="am-swap__b flex min-h-0 flex-1 flex-col">{body("highlight")}</div>
        </div>
      ) : (
        body(mode)
      )}
    </WizardFrame>
  );
}

// ─── Step 3 ──────────────────────────────────────────────────────────────────

const REVIEW_ROWS = [
  ["ผลลัพธ์", "ตัดฉากเด่น · ให้ AI ร่างสคริปต์ · 15 วินาที"],
  ["คลิปต้นฉบับ", `${SAMPLE_CLIPS.length} ไฟล์ · ${fmtClock(SAMPLE_SOURCE_SECONDS)}`],
  ["สไตล์การตัด", "สไตล์เริ่มต้น (ระบบ)"],
  ["เพลงประกอบ", "ไม่ใส่"],
  ["คุณภาพ AI", "Director · ระดับปกติ"],
  ["คำบรรยาย", "เปิด · kanit 72px"],
] as const;

/** WizardStepReview + ProjectNameCard; the start button carries the choreography's press. */
export function WizardReview({ animated = false }: { animated?: boolean }) {
  return (
    <WizardFrame step={3} footer={null}>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-6 lg:flex-row lg:overflow-hidden lg:px-10">
        <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <div className="shrink-0 rounded-md border border-[rgb(217_164_65_/_0.4)] bg-[#1e1c19] px-5 py-4">
            <div className="flex items-center gap-4">
              <span className="shrink-0 text-[15px] font-semibold text-ink">ชื่อโปรเจกต์</span>
              <div className="min-w-0 flex-1">
                <InputBox value={SAMPLE_PROJECT} />
              </div>
            </div>
            <Omit>
              <p className="mt-[9px] text-[13.5px] text-muted">ใช้ในหน้าโปรเจกต์ และชื่อไฟล์ที่ส่งออก · เปลี่ยนทีหลังได้</p>
            </Omit>
            <div className="mt-3 flex flex-wrap items-center gap-x-[9px] gap-y-2 border-t border-[rgb(243_242_242_/_0.1)] pt-3">
              {SAMPLE_CLIPS.map((clip, i) => (
                <span key={clip.file} className="relative shrink-0">
                  <span className="block h-[78px] w-11 shrink-0 overflow-hidden rounded-[4px] border border-[rgb(243_242_242_/_0.14)] bg-[#0e0d0c]">
                    <Tile index={clipTile(i)} className="h-full w-full" />
                  </span>
                  <span className="absolute inset-x-0 bottom-0 bg-[rgb(9_8_7_/_0.72)] pb-[3px] pt-[2px] text-center text-[10px] tabular-nums text-white/85">{fmtClock(clip.seconds)}</span>
                </span>
              ))}
              <span className="text-[13px] leading-[1.6] text-muted">
                {`${SAMPLE_CLIPS.length} คลิปนี้จะต่อกันเป็นวิดีโอเดียว`}
                <br />
                ลากเรียงลำดับได้ในขั้นที่ 1
              </span>
            </div>
          </div>
          <div className="shrink-0 rounded-md border border-divider">
            {REVIEW_ROWS.map(([label, value], i) => (
              <div
                key={label}
                className={cn("flex flex-col items-start gap-1 px-5 py-3.5 xl:flex-row xl:items-center xl:justify-between xl:gap-4", i < REVIEW_ROWS.length - 1 && "border-b border-divider")}
              >
                <span className="shrink-0 text-sm text-muted">{label}</span>
                <span className="flex min-w-0 items-center gap-3">
                  <span className={cn("min-w-0 text-[15px] text-ink xl:truncate", label === "คลิปต้นฉบับ" && "tabular-nums")}>
                    {value}
                  </span>
                  <Omit>
                    <span className="shrink-0 text-sm text-accent underline">แก้</span>
                  </Omit>
                </span>
              </div>
            ))}
          </div>
          <div className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-md border border-divider px-5 py-[18px]">
            <div className="flex shrink-0 items-center justify-between gap-3">
              <p className="text-[15px] font-semibold text-ink">สิ่งที่บอก AI ไว้</p>
              <Omit>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-accent">
                  <Icon name="Pencil" size={14} /> แก้ก่อนเริ่ม
                </span>
              </Omit>
            </div>
            <p className="mt-3 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[15px] leading-[1.75] text-ink-2">
              {`ความยาวเป้าหมาย: ~15 วิ · ${SAMPLE_NOTE}`}
            </p>
            <p className="mt-auto shrink-0 border-t border-divider pt-3.5 text-sm text-muted">แก้ทีหลังได้เสมอ — ข้อความนี้เป็นแนวให้ AI ไม่ใช่คำสั่งสุดท้าย</p>
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-4 lg:w-[320px]">
          <div className="rounded-md border border-divider px-5 py-[18px]">
            <p className="mb-3 text-[15px] font-semibold text-ink">จะเกิดอะไรขึ้นต่อ</p>
            <div className="flex flex-col gap-2.5 text-sm text-ink-2">
              {["นำเข้า", "วิเคราะห์ภาพ", "ตัดต่อ", "คลิปพร้อม"].map((stage, i) => (
                <span key={stage} className="flex gap-2.5">
                  <span className="tabular-nums text-muted">{i + 1}</span>
                  {stage}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-auto flex flex-col gap-2.5">
            <Estimate />
            {animated ? (
              <span className="am-swap am-swap--block" data-am="start">
                <span className="am-swap__a block">
                  <Button variant="primary" className="h-12 w-full text-base" icon={<Icon name="Sparkles" size={17} />} data-am-target="start">
                    เริ่มตัดต่อ
                  </Button>
                </span>
                <span className="am-swap__b block">
                  <Button variant="primary" className="h-12 w-full text-base" icon={<Icon name="Loader2" size={16} className="am-spin" />} disabled>
                    เริ่มตัดต่อ
                  </Button>
                </span>
              </span>
            ) : (
              <Button variant="primary" className="h-12 w-full text-base" icon={<Icon name="Sparkles" size={17} />}>
                เริ่มตัดต่อ
              </Button>
            )}
            <Omit>
              <Button className="w-full" icon={<Icon name="ArrowLeft" size={16} />}>
                ย้อนกลับ
              </Button>
            </Omit>
          </div>
        </div>
      </div>
    </WizardFrame>
  );
}
