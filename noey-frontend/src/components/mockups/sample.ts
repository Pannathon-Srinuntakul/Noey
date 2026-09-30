/**
 * The sample footage every mockup on the site shows. It is an illustration —
 * a made-up product-review take, labelled "ภาพจำลอง" wherever it appears —
 * not anyone's real clip, and it makes no claim about any product.
 */
export interface SampleLine {
  at: string;
  text: string;
  /** keep: stays in the cut · flub: a fluffed take, struck out · gap: silence, cut. */
  kind: "keep" | "flub" | "gap";
}

export const SAMPLE_PROJECT = "โปรเจกต์ตัวอย่าง";

export const SAMPLE_FILES: ReadonlyArray<{ name: string; length: string; tone: number }> = [
  { name: "IMG_4101.MOV", length: "0:42", tone: 1 },
  { name: "IMG_4102.MOV", length: "1:15", tone: 2 },
  { name: "IMG_4105.MOV", length: "0:28", tone: 3 },
  { name: "IMG_4107.MP4", length: "0:51", tone: 4 },
];

export const SAMPLE_LINES: readonly SampleLine[] = [
  { at: "00:01", text: "สวัสดีค่ะ วันนี้มารีวิวเซรั่มขวดนี้", kind: "keep" },
  { at: "00:04", text: "เอ่อ… ขอพูดใหม่นะคะ", kind: "flub" },
  { at: "00:07", text: "เนื้อบางเบา ทาแล้วไม่เหนียว", kind: "keep" },
  { at: "00:10", text: "เงียบ 2.4 วินาที", kind: "gap" },
  { at: "00:13", text: "ขวดเล็ก พกใส่กระเป๋าได้", kind: "keep" },
  { at: "00:16", text: "สนใจกดตะกร้าด้านล่างได้เลยค่ะ", kind: "keep" },
];

/** What the preview's subtitles say: the kept lines, in order. */
export const SAMPLE_SUBTITLES = SAMPLE_LINES.filter((line) => line.kind === "keep").map((line) => line.text);

const segmenter = new Intl.Segmenter("th", { granularity: "word" });

/** Words for a word-by-word animation (never characters: Thai marks would detach). */
export function splitWords(text: string): Array<{ text: string; word: boolean }> {
  return [...segmenter.segment(text)].map((part) => ({ text: part.segment, word: !!part.isWordLike }));
}
