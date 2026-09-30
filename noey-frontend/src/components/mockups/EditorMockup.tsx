import type { CSSProperties } from "react";
import { Waveform } from "../ds/Waveform";
import { SAMPLE_FILES, SAMPLE_LINES, SAMPLE_PROJECT, SAMPLE_SUBTITLES, splitWords } from "./sample";
import "../../styles/mockup.css";

/**
 * The editor, drawn in HTML and CSS (no screenshots, no canvas): media bin,
 * 9:16 preview with Thai subtitles, transcript, and a three-track timeline.
 *
 * It tells the real pipeline in four beats, selected by `data-beat` on the
 * nearest `[data-scene]` ancestor (the pinned hero), or shown all at once
 * (`beat="all"`) where there is no scene:
 *   0 raw clips drop into the bin → 1 waveform + transcript come in word by
 *   word → 2 fluffed takes and silences are struck and cut on the diagonal →
 *   3 what is left flies onto the timeline and the preview plays with
 *   subtitles.
 *
 * Everything inside is an illustration (labelled "ภาพจำลองการทำงาน"): the
 * whole figure has one accessible name and its innards are hidden from
 * assistive technology.
 */
export function EditorMockup({
  variant = "hero",
  label = "ภาพจำลองการทำงาน",
  className,
}: {
  variant?: "hero" | "ambient" | "still";
  label?: string;
  className?: string;
}) {
  let wordIndex = 0;
  return (
    <figure
      className={["ed", `ed--${variant}`, className].filter(Boolean).join(" ")}
      aria-label={`${label}: คลิปดิบหลายไฟล์ถูกถอดเสียงเป็นข้อความ ระบบคัดช่วงที่พูดดี ตัดเทกที่พูดผิดและช่วงเงียบออก แล้วเรียงลงไทม์ไลน์พร้อมซับไทย`}
      data-play=""
    >
      <div className="ed__frame" aria-hidden="true">
        <div className="ed__bar">
          <span className="ed__dots">
            <i />
            <i />
            <i />
          </span>
          <span className="ed__project">{SAMPLE_PROJECT}</span>
          <span className="ed__status">
            <span className="ed__status-dot" />
            <span className="ed__status-text ed__status-text--0">นำเข้า 4 ไฟล์</span>
            <span className="ed__status-text ed__status-text--1">กำลังถอดเสียง</span>
            <span className="ed__status-text ed__status-text--2">คัดช็อต</span>
            <span className="ed__status-text ed__status-text--3">ร่างแรกพร้อม</span>
          </span>
          <span className="ed__bar-tc tc">00:00:18:12</span>
        </div>

        <div className="ed__body">
          <div className="ed__panel ed__bin">
            <span className="ed__label">คลิปดิบ</span>
            <ul className="ed__files">
              {SAMPLE_FILES.map((file, index) => (
                <li key={file.name} className="ed__file" style={{ "--i": index } as CSSProperties}>
                  <span className={`ed__thumb ed__thumb--${file.tone}`}>
                    <span className="ed__thumb-len tc">{file.length}</span>
                  </span>
                  <span className="ed__file-name">{file.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="ed__viewer">
            <div className="ed__screen">
              <div className="scene">
                <span className="scene__light" />
                <span className="scene__table" />
                <span className="scene__bottle">
                  <span className="scene__cap" />
                  <span className="scene__label" />
                </span>
                <span className="scene__hand" />
              </div>
              <div className="ed__subs">
                {SAMPLE_SUBTITLES.map((line, lineIndex) => (
                  <p key={line} className="ed__sub" style={{ "--l": lineIndex } as CSSProperties}>
                    {splitWords(line).map((part, partIndex) =>
                      part.word ? (
                        <span key={partIndex} className="ed__sub-w" style={{ "--w": partIndex } as CSSProperties}>
                          {part.text}
                        </span>
                      ) : (
                        part.text
                      ),
                    )}
                  </p>
                ))}
              </div>
              <span className="ed__safe" />
              <span className="ed__res tc">1080 × 1920</span>
            </div>
          </div>

          <div className="ed__panel ed__script">
            <span className="ed__label">ถอดเสียง</span>
            <div className="ed__lines">
              {SAMPLE_LINES.map((line, lineIndex) => (
                <p key={line.at} className={`ed__line ed__line--${line.kind}`} style={{ "--l": lineIndex } as CSSProperties}>
                  <span className="ed__line-at tc">{line.at}</span>
                  <span className="ed__line-text">
                    {splitWords(line.text).map((part, partIndex) =>
                      part.text.trim() ? (
                        <span key={partIndex} className="ed__w" style={{ "--w": wordIndex++ } as CSSProperties}>
                          {part.text}
                        </span>
                      ) : (
                        part.text
                      ),
                    )}
                  </span>
                  <span className="ed__line-cut" />
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="ed__tl">
          <div className="ed__ruler">
            {["00:00", "00:05", "00:10", "00:15", "00:20"].map((mark) => (
              <span key={mark} className="tc">
                {mark}
              </span>
            ))}
          </div>
          <div className="ed__track ed__track--v">
            <span className="trk tc">V1</span>
            <div className="ed__lane">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className={`ed__clip ed__clip--${index + 1}`} style={{ "--i": index } as CSSProperties} />
              ))}
            </div>
          </div>
          <div className="ed__track ed__track--a">
            <span className="trk tc">A1</span>
            <div className="ed__lane">
              {/* The struck take and the silence sit exactly at the joins between V1's clips. */}
              <Waveform bars={84} seed={11} className="ed__wave" cut={[[22, 29], [40, 47]]} />
              <span className="ed__slash ed__slash--1" />
              <span className="ed__slash ed__slash--2" />
            </div>
          </div>
          <div className="ed__track ed__track--t">
            <span className="trk tc">ซับ</span>
            <div className="ed__lane">
              {SAMPLE_SUBTITLES.map((line, index) => (
                <span key={line} className="ed__cap" style={{ "--i": index } as CSSProperties}>
                  {line}
                </span>
              ))}
            </div>
          </div>
          <span className="ed__playhead" />
        </div>
      </div>
      <figcaption className="ed__tag mock-tag">{label}</figcaption>
    </figure>
  );
}
