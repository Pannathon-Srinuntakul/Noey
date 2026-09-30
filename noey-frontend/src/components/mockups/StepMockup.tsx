import type { CSSProperties } from "react";
import { IconUpload } from "../ds/icons";
import { Waveform } from "../ds/Waveform";
import { SAMPLE_FILES, SAMPLE_SUBTITLES } from "./sample";
import "../../styles/mockup.css";

/**
 * One step of the workflow, drawn in code (stands in for a MediaSlot
 * screenshot until the owner supplies one): importing footage, choosing the
 * mode and voice, and the preview + timeline. Always labelled "ภาพจำลอง";
 * the drawing itself is hidden from assistive technology.
 */
export function StepMockup({ kind, label, ratio = "4 / 3" }: { kind: "import" | "style" | "timeline"; label: string; ratio?: string }) {
  return (
    <figure className={`stepm stepm--${kind}`} aria-label={`ภาพจำลอง: ${label}`} data-play="">
      <div className="stepm__frame" style={{ "--ratio": ratio } as CSSProperties} aria-hidden="true">
        {kind === "import" ? <ImportStep /> : kind === "style" ? <StyleStep /> : <TimelineStep />}
      </div>
      <figcaption className="stepm__tag mock-tag">ภาพจำลอง · {label}</figcaption>
    </figure>
  );
}

function ImportStep() {
  return (
    <>
      <div className="stepm__drop">
        <div>
          <span className="stepm__drop-icon">
            <IconUpload />
          </span>
          <span className="stepm__drop-text">ลากไฟล์มาวางที่นี่</span>
        </div>
      </div>
      <div className="stepm__flying">
        <span className="stepm__count">{SAMPLE_FILES.length}</span>
        {SAMPLE_FILES.slice(0, 2).map((file) => (
          <span key={file.name} className={`ed__thumb ed__thumb--${file.tone}`} />
        ))}
      </div>
      <svg className="stepm__pointer" viewBox="0 0 24 24" fill="currentColor">
        <path d="M5 3l14 8-6.2 1.6L10 19 5 3Z" stroke="var(--bg)" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </>
  );
}

const MODES = ["ตัดช่วงเงียบ", "ตัดฉากเด่น", "ตัดไฮไลต์จากคลิปยาว"];
const VOICES = ["เสียงเดิม", "พากย์ใหม่", "เพลงประกอบ"];

function StyleStep() {
  return (
    <div className="stepm__form">
      <div>
        <div className="stepm__row-label">โหมด</div>
        <div className="stepm__modes">
          {MODES.map((mode, index) => (
            <span key={mode} className={index === 1 ? "stepm__mode stepm__mode--on" : "stepm__mode"}>
              <i />
              {mode}
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className="stepm__row-label">ความยาว</div>
        <div className="stepm__slider" />
      </div>
      <div>
        <div className="stepm__row-label">เสียง</div>
        <div className="stepm__voices">
          {VOICES.map((voice, index) => (
            <span key={voice} className={index === 0 ? "stepm__voice stepm__voice--on" : "stepm__voice"}>
              {voice}
            </span>
          ))}
        </div>
      </div>
      <span className="stepm__go">เริ่มตัด</span>
    </div>
  );
}

function TimelineStep() {
  return (
    <div className="stepm__mini">
      <div className="ed__viewer">
        <div className="ed__screen">
          <div className="scene">
            <span className="scene__light" />
            <span className="scene__table" />
            <span className="scene__bottle">
              <span className="scene__cap" />
              <span className="scene__label" />
            </span>
          </div>
          <div className="ed__subs">
            <p className="ed__sub" style={{ "--l": 0 } as CSSProperties}>
              {SAMPLE_SUBTITLES[1]}
            </p>
          </div>
        </div>
      </div>
      <div className="stepm__tracks">
        <div className="ed__lane">
          {[1, 2, 3, 4].map((index) => (
            <span key={index} className={`ed__clip ed__clip--${index}`} />
          ))}
        </div>
        <div className="ed__lane">
          <Waveform bars={56} seed={5} className="ed__wave" />
        </div>
        <span className="ed__playhead" />
        <span className="stepm__render">เรนเดอร์ใหม่</span>
      </div>
    </div>
  );
}
