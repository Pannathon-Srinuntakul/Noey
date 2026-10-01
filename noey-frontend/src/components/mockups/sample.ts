import footage from "./footage.json";
import footageVersion from "./footage-version.json";

/**
 * The sample project every editor mock-up on the site shows: a short review of
 * a serum in a glass dropper bottle, cut by the "ตัดฉากเด่น" mode from five
 * phone clips. It is an illustration — labelled "ภาพจำลอง" wherever it
 * appears. The footage is rendered for the site (scripts/render-footage: no
 * real product, no brand, no stock), and the script is a generic review line
 * set that makes no claim about skin or health.
 *
 * Everything the mock-ups print about the project comes from here, in the
 * shapes the real editor prints them (web/src): file rows, scene windows,
 * voiceover lines, caption lines, the music track.
 */

export type ShotId = (typeof footage.shots)[number];

export const SAMPLE_PROJECT = "รีวิวเซรั่มขวดแก้ว";

/** The clips as dropped into the wizard, in their final order (คลิปเปิด first, คลิปปิด last). */
export const SAMPLE_CLIPS: ReadonlyArray<{ file: string; seconds: number; megabytes: number; shot: ShotId }> = [
  { file: "IMG_4127.MOV", seconds: 24, megabytes: 106, shot: "pedestal" },
  { file: "IMG_4128.MOV", seconds: 31, megabytes: 137, shot: "texture" },
  { file: "IMG_4130.MOV", seconds: 18, megabytes: 79, shot: "turntable" },
  { file: "IMG_4131.MOV", seconds: 26, megabytes: 115, shot: "rack" },
  { file: "IMG_4133.MOV", seconds: 42, megabytes: 185, shot: "flatlay" },
];

export const SAMPLE_SOURCE_SECONDS = SAMPLE_CLIPS.reduce((sum, clip) => sum + clip.seconds, 0);

/** The voiceover script the AI wrote, one line per sentence. */
export const SAMPLE_LINES: readonly string[] = [
  "ทุกเช้าต้องมีเซรั่มขวดนี้",
  "เนื้อบางเบา ไม่เหนอะหนะ",
  "หยดเดียวก็ทั่วหน้า",
  "ขวดเล็กมีหลอดหยด พกใส่กระเป๋าได้",
  "กดตะกร้าด้านล่างได้เลย",
];

export interface SampleScene {
  /** Index into SAMPLE_CLIPS. */
  clip: number;
  /** Where the scene starts in its clip, in seconds (what the inspector prints). */
  sourceIn: number;
  /** 1-based voiceover line the scene was cut for. */
  line: number;
  /** Backup shots the AI returned with it (the ⟲ badge, ปรับช็อต). */
  alternates: number;
  /** What the AI saw in the shot (ปรับช็อต's note line). */
  note: string;
  /** The caption the editor derives for it — the line's words split across its scenes by length. */
  caption: string;
  /** Seconds on screen: the frames footage.json gives this scene in the rendered cut. */
  seconds: number;
  /** Where it starts in the cut, in seconds. */
  start: number;
  /** Rendered footage behind it (footage.json). */
  shot: ShotId;
  from: number;
  frames: number;
}

// The caption column is what web/src/lib/captionLines.ts (dubCaptionLines)
// makes of these lines and scene lengths in Chrome: each line's words, divided
// between its scenes in proportion to how long each is on screen.
const SCENES: ReadonlyArray<Pick<SampleScene, "clip" | "sourceIn" | "line" | "alternates" | "note" | "caption">> = [
  { clip: 0, sourceIn: 3.2, line: 1, alternates: 2, note: "ขวดบนแท่นหิน กล้องค่อย ๆ เข้าใกล้", caption: "ทุกเช้าต้องมี" },
  { clip: 2, sourceIn: 5.4, line: 1, alternates: 0, note: "ขวดหมุนบนแท่น เห็นฉลาก", caption: "เซรั่มขวดนี้" },
  { clip: 1, sourceIn: 8.1, line: 2, alternates: 3, note: "ใกล้ฉลาก ไล่ขึ้นไปที่คอขวดสีทอง", caption: "เนื้อบางเบา" },
  { clip: 4, sourceIn: 12.6, line: 2, alternates: 0, note: "ขวดวางคู่กล่องบนผ้าลินิน", caption: "ไม่เหนอะหนะ" },
  { clip: 3, sourceIn: 4.0, line: 3, alternates: 1, note: "โฟกัสจากถ้วยเซรั่มไปที่ขวด", caption: "หยดเดียวก็ทั่วหน้า" },
  { clip: 2, sourceIn: 11.2, line: 4, alternates: 1, note: "หมุนให้เห็นหลอดหยดและฝาสีทอง", caption: "ขวดเล็กมีหลอดหยด" },
  { clip: 0, sourceIn: 15.0, line: 4, alternates: 0, note: "ขวดเต็มเฟรม ฝาทองรับแสง", caption: "พกใส่กระเป๋าได้" },
  { clip: 4, sourceIn: 30.5, line: 5, alternates: 1, note: "ขวดกับกล่อง กล้องค่อย ๆ เข้าใกล้", caption: "กดตะกร้าด้านล่างได้เลย" },
];

export const SAMPLE_SCENES: readonly SampleScene[] = SCENES.map((scene, index) => {
  const cut = footage.cut[index];
  const start = footage.cut.slice(0, index).reduce((sum, c) => sum + c.frames, 0) / footage.fps;
  return { ...scene, seconds: cut.frames / footage.fps, start, shot: cut.shot as ShotId, from: cut.from, frames: cut.frames };
});

/** Length of the cut, in seconds. */
export const SAMPLE_CUT_SECONDS = footage.cut.reduce((sum, c) => sum + c.frames, 0) / footage.fps;

/** A voiceover line as its lane block: from its first scene's start to its last scene's end. */
export const SAMPLE_VOICEOVER = SAMPLE_LINES.map((script, index) => {
  const scenes = SAMPLE_SCENES.filter((scene) => scene.line === index + 1);
  const start = scenes[0].start;
  const end = scenes[scenes.length - 1].start + scenes[scenes.length - 1].seconds;
  return { line: index + 1, script, start, seconds: end - start };
});

/** The music the project was given in the wizard, trimmed by the pipeline to the cut. */
export const SAMPLE_MUSIC = { file: "soft_morning_96bpm.mp3", seconds: 45, volume: 0.3 };

/**
 * The music block's waveform: one peak per 1/8 s of the cut, drawn the way
 * MusicBlock draws decoded peaks. A 96 bpm pulse with a slow swell, computed
 * the same on every render. Rounded: Math.sin and Math.exp may differ in the
 * last digit between the server's JavaScript engine and the browser's, and
 * the drawing is rendered on both (a mismatch would not hydrate cleanly).
 */
export const SAMPLE_MUSIC_PEAKS: readonly number[] = Array.from({ length: Math.round(SAMPLE_CUT_SECONDS * 8) }, (_, i) => {
  const t = i / 8;
  const beat = (t * 96) / 60;
  const pulse = Math.exp(-4 * (beat - Math.floor(beat)));
  const swell = 0.62 + 0.38 * Math.sin((t / SAMPLE_CUT_SECONDS) * Math.PI * 1.6 + 0.4);
  const grain = 0.5 + 0.5 * Math.sin(i * 12.9898) * Math.sin(i * 4.1414);
  return Math.round(Math.min(1, 0.18 + (0.5 * pulse + 0.32 * grain) * swell) * 1000) / 1000;
});

// ─── Footage files (public/footage, made by scripts/render-footage/encode.mjs) ──

/** A footage URL, versioned by the files' content hash (they are cached as immutable). */
const file = (name: string) => `/footage/${name}?v=${footageVersion.v}`;

export const FOOTAGE_FPS = footage.fps;
export const FOOTAGE_VIDEO = { webm: file("edit.webm"), mp4: file("edit.mp4") } as const;
/** The still of scene `index` (its middle frame) — poster, reduced motion, shot swap. */
export const sceneStill = (index: number) => ({ avif: file(`scene-${index + 1}.avif`), webp: file(`scene-${index + 1}.webp`) });
/** One of the extra stills footage.json lists (shot swap's other angles). */
export const extraStill = (id: string) => ({ avif: file(`${id}.avif`), webp: file(`${id}.webp`) });
/** Time in the cut that scene `index`'s still shows. */
export const sceneStillTime = (index: number) => {
  const scene = SAMPLE_SCENES[index];
  return scene.start + (Math.floor(scene.frames / 2) + 0.5) / footage.fps;
};

/**
 * Filmstrip tiles: /footage/strip.webp holds every shot's tiles side by side,
 * 54×96 each (the size the web engine extracts), one every half second of the
 * rendered shot, sampled at the middle of each half second.
 */
export const STRIP = { url: file("strip.webp"), tiles: footage.shots.length * footage.tilesPerShot, perShot: footage.tilesPerShot };

/** Tile index for `second` into a scene (clamped to its shot's tiles). */
export function tileAt(scene: Pick<SampleScene, "shot" | "from">, second: number): number {
  const shotIndex = footage.shots.indexOf(scene.shot);
  const shotSecond = scene.from / footage.fps + Math.max(0, second);
  const k = Math.min(footage.tilesPerShot - 1, Math.max(0, Math.floor(shotSecond / 0.5)));
  return shotIndex * footage.tilesPerShot + k;
}

/** background-position (x) of tile `index` in the strip, scaled to one tile's box. */
export const tilePosition = (index: number) => `${(STRIP.tiles > 1 ? (index / (STRIP.tiles - 1)) * 100 : 0).toFixed(4)}% 50%`;

/** A clip's thumbnail tile: the middle of its shot (the rack focus opens out of focus). */
export const clipTile = (clip: number) => footage.shots.indexOf(SAMPLE_CLIPS[clip].shot) * footage.tilesPerShot + Math.floor(footage.tilesPerShot / 2);

export const EXTRA_STILLS = footage.stills;
