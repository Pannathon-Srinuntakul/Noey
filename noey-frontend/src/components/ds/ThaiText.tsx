import { Fragment, type ReactNode } from "react";

/**
 * Words the browser's Thai line breaker cuts in the wrong place. It breaks
 * Thai with a dictionary, and loanwords are missing from it: "โปรเจกต์" breaks
 * as โปร|เจ|กต์, "ครีเอเตอร์" as ค|รี|เอ|เตอร์, and "แพลน" splits inside
 * "ราคาแพลนอื่น". A few native compounds and negations are here too, where a
 * line end between the parts misleads ("ไม่ / จำกัด" reads as "no" at the end
 * of a line).
 */
const KEEP_TOGETHER = [
  "โปรเจกต์",
  "ครีเอเตอร์",
  "เรนเดอร์",
  "ลิมิต",
  "สตูดิโอ",
  "เซรั่ม",
  "พรีวิว",
  "พรีเซ็ต",
  "แพลนปัจจุบัน",
  "แพลน",
  "ร้านค้า",
  "ไทม์ไลน์",
  "ฟุตเทจ",
  "อัปโหลด",
  "อัปเกรด",
  "คอนเทนต์",
  "สกินแคร์",
  "รายละเอียด",
  "การชำระเงิน",
  "ใช้งาน",
  "มือถือ",
  "แนวตั้ง",
  "ส่วนตัว",
  "ทีมงาน",
  "ไม่จำกัด",
  "ลบให้ไม่ได้",
  "ไม่ได้",
  "เทก",
  "แท็บ",
  "ไอพี",
  "เกลา",
  "คำตอบ",
  "ยังไง",
  "ไฟล์ดิบ",
  "Reels หรือ Shorts",
];

/** A number and its unit stay on one line ("10 GB", "499 บาท", "30 นาที"). */
const NUMBER_UNIT = "\\d[\\d,.]*\\s(?:GB|MB|นาที|วินาที|บาท|คลิป|โปรเจกต์|งาน|วัน|ชั่วโมง|เดือน|ไฟล์|ปี)";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = new RegExp(
  `(${NUMBER_UNIT}|${[...KEEP_TOGETHER].sort((a, b) => b.length - a.length).map(escape).join("|")})`,
  "g",
);

/**
 * Thai text with those words and number–unit pairs wrapped so a line never
 * ends inside them. The text itself is unchanged (the wrappers are plain
 * spans), so copy, search and screen readers see the same words.
 */
export function keepThai(text: string): ReactNode {
  const parts = text.split(PATTERN);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="kt">
        {part}
      </span>
    ) : part ? (
      <Fragment key={index}>{part}</Fragment>
    ) : null,
  );
}

/** The same split as keepThai, as data: runs to keep whole, and the text between them. */
export function keepSegments(text: string): { text: string; keep: boolean }[] {
  return text
    .split(PATTERN)
    .map((part, index) => ({ text: part, keep: index % 2 === 1 }))
    .filter((part) => part.text);
}
