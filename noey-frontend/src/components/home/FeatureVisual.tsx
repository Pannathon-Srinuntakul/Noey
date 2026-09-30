import type { CSSProperties } from "react";
import { IconMic } from "../ds/icons";
import { Waveform } from "../ds/Waveform";
import { SAMPLE_SUBTITLES } from "../mockups/sample";

/**
 * The picture on each of the three big feature cards (home bento), drawn in
 * code and hidden from assistive technology — the card's heading and text
 * say everything:
 *   0 cuts landing where sentences end, 1 a script read line by line with one
 *   line being re-recorded, 2 the whole editor inside a browser window.
 */
export function FeatureVisual({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="fv fv--cut" aria-hidden="true">
        <div className="fv__words">
          {[0, 1, 2].map((position) => (
            <span key={position} className="fv__sentence" style={{ "--i": position } as CSSProperties} />
          ))}
        </div>
        <div className="fv__wave">
          <Waveform bars={72} seed={21} />
          {[0.26, 0.55, 0.83].map((at, position) => (
            <span key={at} className="fv__cutline" style={{ left: `${at * 100}%`, "--i": position } as CSSProperties} />
          ))}
          <span className="fv__play" />
        </div>
        <div className="fv__clips">
          <span style={{ flex: 26 }} />
          <span style={{ flex: 29 }} />
          <span style={{ flex: 28 }} />
          <span style={{ flex: 17 }} />
        </div>
      </div>
    );
  }
  if (index === 1) {
    return (
      <div className="fv fv--voice" aria-hidden="true">
        {SAMPLE_SUBTITLES.slice(1).map((line, position) => (
          <div key={line} className={position === 1 ? "fv__line fv__line--rec" : "fv__line"}>
            <span className="fv__line-n tc">{String(position + 1).padStart(2, "0")}</span>
            <span className="fv__line-text">{line}</span>
            {position === 1 ? (
              <span className="fv__rec">
                <IconMic size={14} />
                <span className="fv__meter">
                  {[0, 1, 2, 3, 4].map((bar) => (
                    <i key={bar} style={{ "--i": bar } as CSSProperties} />
                  ))}
                </span>
              </span>
            ) : (
              <span className="fv__done" />
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="fv fv--browser" aria-hidden="true">
      <div className="fv__window">
        <div className="fv__chrome">
          <span className="fv__lights">
            <i />
            <i />
            <i />
          </span>
          <span className="fv__address">
            <span className="fv__lock" />
          </span>
        </div>
        <div className="fv__app">
          <span className="fv__side" />
          <span className="fv__preview" />
          <span className="fv__timeline">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </div>
  );
}
