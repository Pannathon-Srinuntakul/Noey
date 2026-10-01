import { SAMPLE_PROJECT, SAMPLE_SCENES, extraStill, sceneStill } from "../sample";
import { Button, Icon, Omit, Still, cn } from "./ui";

/**
 * ปรับช็อต (web/src/components/projects/ShotSwapReview.tsx) opened on scene 3
 * of the sample cut: the scene in use and the three backup shots the AI
 * returned with it. `picked` shows the state after choosing backup 1; the
 * choreography stacks both (data-am="swap").
 */

const OPTIONS = [
  { still: sceneStill(2), label: "AI เลือกไว้", note: SAMPLE_SCENES[2].note },
  { still: extraStill("alt-texture"), label: "อีกมุมหนึ่ง", note: "ใกล้ขึ้น เห็นฉลากและคอขวดชัด" },
  { still: extraStill("alt-flatlay"), label: "อีกมุมหนึ่ง", note: "ขวดคู่กับกล่อง ขวดอยู่ด้านหน้า" },
  { still: extraStill("alt-rack"), label: "อีกมุมหนึ่ง", note: "ขวดชัด ถ้วยเซรั่มเบลออยู่ด้านหน้า" },
];

/** The frame width ShotSwapReview measures for a 1280×800 window (four cards). */
export const SWAP_FRAME_W = 225;

function Cards({ picked }: { picked: boolean }) {
  return (
    <div className="mt-[22px] flex shrink-0 items-start gap-3 self-stretch overflow-x-auto pb-1 sm:justify-center sm:gap-5 sm:overflow-visible">
      {OPTIONS.map((option, i) => {
        const chosen = picked ? i === 1 : i === 0;
        const replaced = picked && i === 0;
        return (
          <div key={i} className="flex w-[46vw] max-w-[210px] shrink-0 flex-col sm:w-auto sm:max-w-none" style={{ width: SWAP_FRAME_W }} data-am-target={i === 1 ? "alt" : undefined}>
            <div
              className={cn(
                "relative aspect-[9/16] w-full overflow-hidden rounded-[5px] bg-media",
                chosen ? "border-2 border-accent" : "border border-[rgb(243_242_242_/_0.18)]",
                replaced && "opacity-50",
              )}
            >
              <Still src={option.still} className="h-full w-full object-cover" />
              {chosen ? (
                <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-[rgb(23_22_20_/_0.82)] py-[5px] pl-2 pr-3 text-[13px] font-semibold text-accent">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[11px] text-[#171614]">✓</span>
                  {i === 0 ? "ใช้อยู่" : "เลือกอันนี้"}
                </span>
              ) : null}
            </div>
            <p className={cn("mt-[11px] text-center text-[15px]", chosen || !replaced ? "text-ink-2" : "text-muted")}>{picked && i === 0 ? "AI เลือกไว้ (ตัวเดิม)" : option.label}</p>
            <p className="mt-[3px] truncate text-center text-[13.5px] text-muted">{option.note}</p>
          </div>
        );
      })}
    </div>
  );
}

function Footer({ picked }: { picked: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-3 px-6 pb-[22px] pt-5">
      <span className="w-full min-w-0 text-[13.5px] text-muted sm:w-auto sm:flex-1">
        {picked ? (
          <>
            <span className="text-ink-2">เปลี่ยนแล้ว 1 ช็อต</span> · ความยาวจะเปลี่ยนตามช็อตที่เลือก · ของเดิมย้อนกลับได้เสมอ
          </>
        ) : (
          "แตะภาพเพื่อเลือก — อันที่เลือกจะเล่นวนให้ดู"
        )}
      </span>
      <Omit>
        <span className="shrink-0 text-[13.5px] text-ink-2">{`ไล่ดูทั้ง ${SAMPLE_SCENES.length} ช็อต`}</span>
      </Omit>
      <span className="flex-1" />
      <Omit>
        <Button variant="ghost">ย้อนกลับ</Button>
      </Omit>
      <Button variant="secondary">ถัดไป</Button>
      {picked ? <Button variant="primary">ทำคลิปใหม่ · 1 ช็อต</Button> : null}
    </div>
  );
}

/** The modal over its scrim; the editor behind is passed in (`behind`). */
export function ShotSwap({ behind, picked = false, animated = false }: { behind?: React.ReactNode; picked?: boolean; animated?: boolean }) {
  const index = 2;
  return (
    <div className="relative h-full">
      {behind}
      <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[rgb(23_22_20_/_0.72)]">
        <div
          style={{ width: "min(1280px, 100cqw - 64px)", height: "calc(100cqh - 64px)" }}
          className="flex flex-col overflow-hidden rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-modal"
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-divider pl-[22px] pr-2.5">
            <span className="text-[15px] font-semibold text-ink">ปรับช็อต</span>
            <span className="min-w-0 truncate text-[13.5px] text-muted">{SAMPLE_PROJECT}</span>
            <span className="flex-1" />
            <span className="hidden min-w-0 shrink items-center gap-[7px] sm:flex">
              {SAMPLE_SCENES.map((scene, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 w-[22px] min-w-[3px] shrink rounded-sm",
                    i === index ? "bg-accent" : scene.alternates > 0 ? "bg-[rgb(243_242_242_/_0.45)]" : "bg-[rgb(243_242_242_/_0.16)]",
                  )}
                />
              ))}
            </span>
            <span className="shrink-0 text-[13.5px] tabular-nums text-muted">{`${index + 1} / ${SAMPLE_SCENES.length}`}</span>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted">
              <Icon name="X" size={17} />
            </span>
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="flex h-full flex-col items-center overflow-y-auto px-6 pt-[26px]">
              <div className="flex shrink-0 flex-col items-center">
                <p className="text-[22px] font-semibold text-ink">ช็อตนี้เอาอันไหน</p>
                <p className="mt-[7px] text-center text-sm text-muted">
                  ตอนที่พูดว่า <span className="text-ink-2">&ldquo;เนื้อบางเบา ไม่เหนอะหนะ&rdquo;</span>
                </p>
              </div>
              {animated ? (
                <div className="am-swap am-swap--block self-stretch" data-am="swap">
                  <div className="am-swap__a">
                    <Cards picked={false} />
                  </div>
                  <div className="am-swap__b">
                    <Cards picked />
                  </div>
                </div>
              ) : (
                <Cards picked={picked} />
              )}
            </div>
          </div>
          {animated ? (
            <div className="am-swap am-swap--block" data-am="swap">
              <div className="am-swap__a">
                <Footer picked={false} />
              </div>
              <div className="am-swap__b">
                <Footer picked />
              </div>
            </div>
          ) : (
            <Footer picked={picked} />
          )}
        </div>
      </div>
    </div>
  );
}
