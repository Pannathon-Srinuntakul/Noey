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
  "ประมวลผล",
  "ออกจากระบบ",
  "ไม่ผูก",
  "คอมพิวเตอร์",
  "ในห้องตัดต่อ",
  "ห้องตัดต่อ",
  "ถ้ามี",
  "คืนเงิน",
  "อีกต่อไป",
  "สไตล์",
  "อัดเสียง",
  "เข้าใช้",
  "บัญชีเดียว",
  "ของคุณ",
  "สิบนาที",
  "ร่างแรก",
  "5-hour",
  "ผู้ให้บริการ",
  "ถูกต้อง",
  "ทางอ้อม",
  "ภัยธรรมชาติ",
  "ภาพรวม",
  "เข้าสู่ระบบ",
  "ค่าใช้จ่าย",
  "ขาดรายได้",
  "รับผิด",
  "ความเป็นส่วนตัว",
];

/** A number and its unit stay on one line ("10 GB", "499 บาท", "30 นาที"), and so
 * does a plan name with the value after it ("Starter 20 นาที"). */
const NUMBER_UNIT =
  "(?:(?:ฟรี|Lite|Starter|Pro|Studio|Agency|Max) )?\\d[\\d,.]*\\s(?:GB|MB|นาที|วินาที|บาท|คลิป|โปรเจกต์|งาน|วัน|ชั่วโมง|เดือน|ไฟล์|ปี)";

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

/**
 * Short words that lean on the next one: a line must not end right after
 * them. "ไม่ / กิน" reads as "no" at the end of the line; "การ / ขาดรายได้",
 * "ความ / รับผิด", "ผู้ / ปกครอง", "ค่า / บริการ", "ใน / ห้องตัดต่อ" split a
 * phrase the reader takes as one word.
 */
const LEANS_ON_NEXT = new Set(["ไม่", "การ", "ความ", "ผู้", "ค่า", "ใน"]);

// Made on first use: the module is shipped to the browser too (keepThai),
// where only keepThaiProse would ever need a segmenter.
let words: Intl.Segmenter | undefined;

/**
 * keepThai for long copy rendered on the server only: the same protected
 * words, plus each word from LEANS_ON_NEXT glued to the word after it, found
 * with the Thai word segmenter. Server components only — a client component
 * would re-segment in the browser, whose dictionary may differ, and the
 * hydrated text would not match; client components use keepThai.
 */
export function keepThaiProse(text: string): ReactNode {
  const tokens: { text: string; keep: boolean; word: boolean }[] = [];
  for (const part of keepSegments(text)) {
    if (part.keep) tokens.push({ text: part.text, keep: true, word: true });
    else {
      words ??= new Intl.Segmenter("th", { granularity: "word" });
      for (const piece of words.segment(part.text)) tokens.push({ text: piece.segment, keep: false, word: !!piece.isWordLike });
    }
  }
  const runs: { text: string; keep: boolean }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.keep && LEANS_ON_NEXT.has(token.text) && tokens[index + 1]?.word) {
      let glued = token.text;
      let next = index + 1;
      glued += tokens[next].text;
      while (!tokens[next].keep && LEANS_ON_NEXT.has(tokens[next].text) && tokens[next + 1]?.word) glued += tokens[++next].text;
      runs.push({ text: glued, keep: true });
      index = next;
    } else if (!token.keep && runs.length > 0 && !runs[runs.length - 1].keep) {
      runs[runs.length - 1].text += token.text;
    } else {
      runs.push({ text: token.text, keep: token.keep });
    }
  }
  if (runs.length === 1 && !runs[0].keep) return text;
  return runs.map((run, index) =>
    run.keep ? (
      <span key={index} className="kt">
        {run.text}
      </span>
    ) : (
      <Fragment key={index}>{run.text}</Fragment>
    ),
  );
}

/** The same split as keepThai, as data: runs to keep whole, and the text between them. */
export function keepSegments(text: string): { text: string; keep: boolean }[] {
  return text
    .split(PATTERN)
    .map((part, index) => ({ text: part, keep: index % 2 === 1 }))
    .filter((part) => part.text);
}
