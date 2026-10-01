import type { Metadata } from "next";
import Link from "next/link";
import { waveform } from "@/components/ds/timecode";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: `ไม่พบหน้าที่ต้องการ | ${SITE_NAME}` },
  robots: { index: false, follow: true },
};

/* Geometry of the drawing, in SVG units (viewBox 720 × 156). */
// The splice's slant: x moves 0.2 back for every 1 down — the "/" of the cut
// between the logo's two halves, the same as the page transition's cut.
const K = -0.2;
const GAP_TOP = 26;
const GAP_L = 388;
const GAP_R = 478;
const edgeL = (y: number) => GAP_L + (y - GAP_TOP) * K;
const edgeR = (y: number) => GAP_R + (y - GAP_TOP) * K;

type Lane = { top: number; bottom: number; aEnd: number; bStart: number };
const VIDEO: Lane = { top: 34, bottom: 80, aEnd: 212, bStart: 218 };
const AUDIO: Lane = { top: 88, bottom: 124, aEnd: 176, bStart: 182 };

function clipsOf(lane: Lane) {
  const t = lane.top + 2;
  const b = lane.bottom - 2;
  return {
    a: `54,${t} ${lane.aEnd},${t} ${lane.aEnd},${b} 54,${b}`,
    b: `${lane.bStart},${t} ${edgeL(t) - 4},${t} ${edgeL(b) - 4},${b} ${lane.bStart},${b}`,
    c: `${edgeR(t) + 4},${t} 712,${t} 712,${b} ${edgeR(b) + 4},${b}`,
  };
}

const V = clipsOf(VIDEO);
const A = clipsOf(AUDIO);

/*
 * The ruler ticks and the audio waveform are each ONE path, not one element
 * per tick or bar: the root not-found tree travels in every page's RSC
 * payload, so its size is paid on every page load.
 */
// The ruler at the drawing's own time scale (91 units a second): a tick every
// tenth of a second, a taller one on each second, all of them below the
// times' baseline so no tick runs through a digit. They run the lane's whole
// length; the time readout's box covers the last few on a desktop.
const SECOND = 91;
const TICKS_PATH = Array.from({ length: 73 }, (_, index) => `M${(54 + index * (SECOND / 10)).toFixed(1)} ${index % 10 === 0 ? 11 : 14.5}V18`).join("");
const WAVE_PATH = (() => {
  const mid = (AUDIO.top + AUDIO.bottom) / 2;
  return waveform(132, 53)
    .map((height, index) => {
      const half = Math.max(1, Math.round(height * 13));
      return `M${55.5 + index * 5} ${mid - half}V${mid + half}`;
    })
    .join("");
})();

/**
 * 404: a timeline with one clip missing — the hole cut on the logo's
 * diagonal through every track — and a playhead that runs along and drops
 * into it. Played once. With reduced motion (or no CSS animation) the
 * playhead is simply lying in the hole. Decorative: the page's text says
 * everything.
 */
function MissingClip() {
  return (
    <svg className="nf__svg" viewBox="0 0 720 156" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="nf-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" className="nf__hatch" />
        </pattern>
        <clipPath id="nf-audio">
          <polygon points={A.a} />
          <polygon points={A.b} />
          <polygon points={A.c} />
        </clipPath>
      </defs>

      {/* Ruler */}
      <line x1="50" y1="18" x2="716" y2="18" className="nf__rule" />
      <path d={TICKS_PATH} className="nf__tick" />
      {/* 91 units a second: the hole's centre sits at 00:00:04:04. Each time
          starts just right of its second's tick. */}
      {[0, 2, 4].map((second) => (
        <text key={second} x={57 + second * SECOND} y="9" className="nf__tc">
          {`00:00:0${second}:00`}
        </text>
      ))}
      {/* Track labels and lanes */}
      {[VIDEO, AUDIO].map((lane, index) => (
        <g key={lane.top}>
          <rect x="4" y={lane.top + (lane.bottom - lane.top) / 2 - 10} width="34" height="20" rx="5" className="nf__trk" />
          <text x="21" y={lane.top + (lane.bottom - lane.top) / 2 + 3.5} textAnchor="middle" className="nf__trk-text">
            {index === 0 ? "V1" : "A1"}
          </text>
          <rect x="50" y={lane.top} width="666" height={lane.bottom - lane.top} rx="7" className="nf__lane" />
        </g>
      ))}

      {/* The hole where a clip should be, all the way down */}
      <polygon
        points={`${GAP_L},${GAP_TOP} ${GAP_R},${GAP_TOP} ${edgeR(156)},156 ${edgeL(156)},156`}
        className="nf__hole"
      />
      <polygon
        points={`${GAP_L},${GAP_TOP} ${GAP_R},${GAP_TOP} ${edgeR(156)},156 ${edgeL(156)},156`}
        className="nf__hole-hatch"
      />

      {/* Video clips */}
      <polygon points={V.a} className="nf__clip" />
      <polygon points={V.b} className="nf__clip" />
      <polygon points={V.c} className="nf__clip" />

      {/* Audio clips with their waveform */}
      <polygon points={A.a} className="nf__clip nf__clip--audio" />
      <polygon points={A.b} className="nf__clip nf__clip--audio" />
      <polygon points={A.c} className="nf__clip nf__clip--audio" />
      <path d={WAVE_PATH} clipPath="url(#nf-audio)" className="nf__bar" />

      {/* The playhead: runs, reaches the hole, falls in */}
      <g className="nf__head">
        <path d="M-6 -12 H6 V-5 L0 0 L-6 -5 Z" className="nf__cap" />
        <line x1="0" y1="0" x2="0" y2="118" className="nf__line" />
      </g>
    </svg>
  );
}

/** The lead's last sentence stays on one line: a narrow screen breaks between the sentences. */
const LEAD = "ลิงก์นี้อาจพิมพ์ผิด หรือหน้าถูกย้ายไปแล้ว ลองเริ่มจากหน้าเหล่านี้แทน";
const LEAD_BREAK = LEAD.lastIndexOf(" ");

export default function NotFound() {
  return (
    <main id="main" className="status-page page-top nf">
      <div className="wrap nf__inner">
        <div className="nf__stage">
          <MissingClip />
          {/* The playhead's current time, boxed like an editor's time display;
              it counts with the run (its digits are CSS counters). */}
          <span className="nf__readout" aria-hidden="true" />
          <span className="mock-tag nf__tag">ภาพจำลอง</span>
        </div>

        <div className="nf__copy">
          <p className="nf__code tc">404</p>
          <h1 className="nf__title">ไม่พบหน้าที่ต้องการ</h1>
          <p className="nf__lead">
            {LEAD.slice(0, LEAD_BREAK)} <span className="kt">{LEAD.slice(LEAD_BREAK + 1)}</span>
          </p>
          <ul className="nf__links">
            <li>
              <Link href="/" className="btn btn-primary btn-lg">
                กลับหน้าแรก
              </Link>
            </li>
            <li>
              <Link href="/pricing" className="btn btn-secondary btn-lg">
                ดูราคา
              </Link>
            </li>
            <li>
              <Link href="/scope" className="btn btn-secondary btn-lg">
                ดูว่าทำอะไรได้บ้าง
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
