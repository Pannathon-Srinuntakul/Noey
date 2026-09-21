/**
 * Generated OG images are drawn by satori, which does not position a Thai tone
 * mark that sits on top of an upper vowel: "ที่" renders as "ที", "เปลี่ยน" as
 * "เปลียน" (measured 2026-09-21 with Noto Sans Thai, Sarabun, Kanit and Prompt
 * — all fonts drop it, so it is the renderer, not the font). OG copy therefore
 * avoids those syllables; this check keeps future edits honest (unit-tested).
 */

const UPPER_VOWELS = "ัิีึื็"; // ั ิ ี ึ ื ็
const TONE_MARKS = "่้๊๋์"; // ่ ้ ๊ ๋ ์

const STACKED = new RegExp(`[${UPPER_VOWELS}][${TONE_MARKS}]`);

export function hasStackedThaiMarks(text: string): boolean {
  return STACKED.test(text);
}
