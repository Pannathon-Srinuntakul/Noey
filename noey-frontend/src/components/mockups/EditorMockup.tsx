import { AppScreen } from "./app/AppScreen";
import { DEMO_PICK, EditorScreen } from "./app/Editor";
import { EditorLive } from "./app/EditorLive";
import { MockLive } from "./app/MockLive";
import { JobProgress } from "./app/Pages";
import { WizardFiles, WizardOutcome, WizardReview } from "./app/Wizard";
import { Pointer } from "./app/Pointer";
import { sceneStillTime } from "./sample";
import "./app/hero.css";

/**
 * The app itself, in the order a new user meets it (web/src, the web build):
 *   0 the wizard's file step — five clips dropped in;
 *   1 the outcome step — ตัดฉากเด่น, 15 วิ — then the review and เริ่มตัดต่อ;
 *   2 the job progress page, stage by stage;
 *   3 the timeline editor with the cut playing, captions on the preview —
 *     the pointer picks a scene, then the visitor can scrub and pick too.
 *
 * Every screen is the real layout at a 1024×768 window (see app/), always
 * whole: on a phone it scales down like every other picture of the app. In
 * the hero the beat comes from `data-beat` on the nearest
 * `[data-scene]` (MotionRuntime); the "ambient" variant (sign-up / log-in) is
 * the editor alone, playing; "still" is the editor at rest.
 *
 * An illustration: labelled "ภาพจำลอง…", one accessible name; the pictures
 * are hidden from assistive technology, and only the editor's timeline
 * controls (scrub, scenes, notes) are reachable, once its beat is showing.
 */

export const HERO_WINDOW = { width: 1024, height: 768 };
/** How long each beat plays where beats advance on a timer (phones, short windows) (ms). */
export const HERO_BEAT_MS = [5200, 7600, 5600, 15600];

function Screen({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className={`edm__screen edm__screen--${name}`}>
      <AppScreen width={HERO_WINDOW.width} height={HERO_WINDOW.height}>
        {children}
      </AppScreen>
    </div>
  );
}

const T0 = sceneStillTime(2);

export function EditorMockup({
  variant = "hero",
  label = "ภาพจำลองการทำงาน",
  className,
}: {
  variant?: "hero" | "ambient" | "still";
  label?: string;
  className?: string;
}) {
  const editor = (beat?: number) => (
    <EditorScreen
      windowWidth={HERO_WINDOW.width}
      time={T0}
      interactive={variant === "hero"}
      video={variant === "still" ? undefined : <EditorLive beat={beat} demoPick={beat === undefined ? undefined : DEMO_PICK} />}
    />
  );
  return (
    <figure
      className={["edm", `edm--${variant}`, className].filter(Boolean).join(" ")}
      aria-label={
        variant === "hero"
          ? `${label}: หน้าจอของ Noey Studio ตามลำดับที่ใช้จริง ลากคลิปเข้าหน้าสร้างวิดีโอใหม่ เลือกโหมดตัดฉากเด่นและความยาว 15 วินาที กดเริ่มตัดต่อ รอระบบนำเข้า วิเคราะห์ภาพ และตัดต่อ แล้วเปิดคลิปที่ตัดแล้วในหน้าแก้ไขวิดีโอ พรีวิวแนวตั้งพร้อมคำบรรยายไทย และฉากที่เรียงบนไทม์ไลน์`
          : `${label}: หน้าแก้ไขวิดีโอของ Noey Studio พรีวิวแนวตั้งพร้อมคำบรรยายไทย และฉากที่ตัดแล้วเรียงบนไทม์ไลน์`
      }
      data-play=""
    >
      <div className="edm__stage">
        {variant === "hero" ? (
          <>
            <div className="edm__beat edm__beat--0" aria-hidden="true">
              <Screen name="files">
                <WizardFiles animated />
                <Pointer name="files" drag />
              </Screen>
            </div>
            <div className="edm__beat edm__beat--1" aria-hidden="true">
              <Screen name="outcome">
                <WizardOutcome animated />
                <Pointer name="outcome" />
              </Screen>
              <Screen name="review">
                <WizardReview animated />
                <Pointer name="review" />
              </Screen>
            </div>
            <div className="edm__beat edm__beat--2" aria-hidden="true">
              <Screen name="progress">
                {/* From the AI's first stage to the cut: 25% → 50%. */}
                <JobProgress states={[1, 2, 3]} />
              </Screen>
            </div>
            <div className="edm__beat edm__beat--3">
              <Screen name="editor">
                {editor(3)}
                <Pointer name="editor" />
              </Screen>
            </div>
          </>
        ) : (
          <Screen name="editor">{editor()}</Screen>
        )}
        <MockLive />
      </div>
      <figcaption className="edm__tag mock-tag">{label}</figcaption>
    </figure>
  );
}
