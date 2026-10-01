import { AppScreen, type Crop } from "./app/AppScreen";
import { HEADER_COL_PX, LaneCrop, fitPxPerSec } from "./app/Editor";
import { MockLive } from "./app/MockLive";
import { ExportRow, JobProgressMessage } from "./app/Pages";
import { SAMPLE_SCENES } from "./sample";
import "./app/parts.css";

/**
 * The six small feature cards' pictures: each a strip cut from the part of the
 * app that does the job — the caption lane, the music lane and its volume, a
 * scene being trimmed, a scene swapped for its backup shot, clips being
 * converted, the finished file ticked for export. The motion is in parts.css
 * (only on screen, never with reduced motion). Decorative: the card's text
 * says what it shows.
 */
export type MicroKind = "subs" | "music" | "trim" | "swap" | "convert" | "frame";

const WINDOW = 1024;
const PX = fitPxPerSec(WINDOW);
const scene3 = HEADER_COL_PX + SAMPLE_SCENES[2].start * PX;

/** Window size and crop for each strip (window pixels; strips are about 6:1). */
const STRIPS: Record<MicroKind, { width: number; height: number; crop: Crop }> = {
  subs: { width: WINDOW, height: 40, crop: { x: 4, y: -8, w: 330, h: 56 } },
  music: { width: WINDOW, height: 40, crop: { x: 4, y: -12, w: 380, h: 64 } },
  trim: { width: WINDOW, height: 72, crop: { x: scene3 - 130, y: 0, w: 424, h: 72 } },
  swap: { width: WINDOW, height: 48, crop: { x: scene3 - 90, y: 0, w: 284, h: 48 } },
  convert: { width: 440, height: 100, crop: { x: 0, y: 44, w: 300, h: 50 } },
  frame: { width: 572, height: 76, crop: { x: 0, y: 0, w: 448, h: 76 } },
};

export function MicroDemo({ kind }: { kind: MicroKind }) {
  const { width, height, crop } = STRIPS[kind];
  return (
    <span className={`ammini ammini--${kind}`} aria-hidden="true" data-play="">
      <AppScreen width={width} height={height} crop={crop}>
        {kind === "convert" ? <JobProgressMessage animated /> : kind === "frame" ? <ExportRow animated /> : <LaneCrop kind={kind} px={PX} />}
      </AppScreen>
      <MockLive />
    </span>
  );
}
