import { Fragment, type ReactNode } from "react";

/**
 * Words the browser's Thai line breaker cuts in the wrong place. It breaks
 * Thai with ICU's dictionary, and loanwords are missing from it: "โปรเจกต์"
 * breaks as โปร|เจ|กต์, "ครีเอเตอร์" as ค|รี|เอ|เตอร์, and "แพลน" splits inside
 * "ราคาแพลนอื่น". A few native compounds and negations are here too, where a
 * line end between the parts misleads ("ไม่ / จำกัด" reads as "no" at the end
 * of a line). Long copy rendered on the server gets far more
 * (ThaiProse.tsx, from the generated thai-glossary.json).
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
  "รับผิดชอบ",
  "รับผิด",
  "ความเป็นส่วนตัว",
  "ผู้ใช้",
  "ค่าบริการ",
  "ทีละขั้น",
  "ทีละ",
  "สัปดาห์ละ",
  "ครั้งละ",
  "วันละ",
  "คลิปสั้น",
  "เสียงเดิม",
  "พากย์เอง",
  "เกิดขึ้น",
  "ดีขึ้น",
  "ผ่าน Chrome",
  "เสร็จแล้ว",
  "เริ่มใช้งาน",
  "ลบเองได้",
  "ทุกอุปกรณ์",
  "Noey Studio",
  "เข้าสู่ระบบด้วย Google",
  "ผูกบัตร",
  "ถามซ้ำ",
  "ไม่ใช่ปัญหา",
  "สามแบบ",
  "โปรแกรมอื่น",
  "ส่งข้อความ",
  "ชื่อโปรเจกต์",
  "เลือกช่วง",
  "สำรองไฟล์",
  "อ้างสิทธิ",
  "ผิดเงื่อนไข",
  "รอบบิล",
  "รายอื่น",
  "วันที่อัปเดต",
  "ใช้บริการ",
  "หมายเลขไอพี",
  "ผิดวัตถุประสงค์",
  "ส่งได้ที่",
  "โมชัน",
  "ซับไทย",
  "แค่ไหน",
  "ถอดเสียง",
  "พิมพ์ซับ",
  "สคริปต์ขาย",
  "ได้ไม่ดี",
  "ปุ่มเดียว",
  "ให้บ้าง",
  "แล้วจบ",
  "แก้ทับ",
  "ไว้ที่เดียว",
  "Trial credit",
  "Weekly limit",
  "5-hour limit",
  "ไม่ได้รับ",
  "พื้นที่เก็บงาน",
  "ใช้งานหนัก",
  "ใบเสร็จ",
  "รหัสผ่านใหม่",
  "ลิงก์ยืนยันใหม่",
  "บัญชีเดียวกันนี้",
  "ใช้งานจริง",
];

/** A number and its unit stay on one line ("10 GB", "499 บาท", "30 นาที"), and so
 * does a plan name with the value after it ("Starter 20 นาที") and an estimate
 * with its "ราว" ("ราว 22 คลิป"). */
const NUMBER_UNIT =
  "(?:(?:ฟรี|Lite|Starter|Pro|Studio|Agency|Max|ราว) )?\\d[\\d,.]*\\s(?:GB|MB|นาที|วินาที|บาท|คลิป|โปรเจกต์|งาน|วัน|ชั่วโมง|เดือน|ไฟล์|ปี)";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = new RegExp(
  `(${NUMBER_UNIT}|${[...KEEP_TOGETHER].sort((a, b) => b.length - a.length).map(escape).join("|")})`,
  "g",
);

/**
 * Marks that never start a line: the repeat mark ๆ ("สั้น ๆ") and the "·"
 * between the items of a run ("ฟรี 10 นาที · Lite 10 นาที"). The space before
 * each becomes a no-break space, which keeps it on the word before it.
 */
export const glueMarks = (text: string) => text.replace(/ ([ๆ·])/g, "\u00a0$1");

/**
 * Thai text with those words and number–unit pairs wrapped so a line never
 * ends inside them. The text is unchanged apart from the no-break spaces
 * before ๆ and "·" (the wrappers are plain spans), so copy, search and screen
 * readers see the same words.
 */
export function keepThai(source: string): ReactNode {
  const text = glueMarks(source);
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
