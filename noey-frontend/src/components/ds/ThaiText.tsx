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
  "ดราฟต์แรก",
  "ดราฟต์",
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
  "Safari 26 ขึ้นไป",
  "ยังใช้บนมือถือ",
  "ทุกอุปกรณ์แล้ว",
  "หน้าตั้งค่า",
  "ตัดได้",
  "ตัดซ้อน",
  "คัดช็อต",
  "(ภายในพื้นที่ที่ได้)",
  // The modes' names, and phrases the guides split (final review).
  "ตัดฉากเด่น",
  "ตัดช่วงเงียบ",
  "ตัดไฮไลต์จากคลิปยาว",
  "ติดตั้งอะไร",
  "เกณฑ์ที่ 1",
  "เกณฑ์ที่ 2",
  "เกณฑ์ที่ 3",
  "เกณฑ์ที่ 4",
  "เกณฑ์ที่ 5",
  "ทีละตัว",
  "สคริปต์ AI",
  "โหมดไฮไลต์",
  "ระดับละเอียด",
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
  "กดปุ่มเดียว",
  "ถอดเสียงพูด",
  "คิดราคาปกติ",
  "มีผลบังคับ",
  "Trial credit",
  "Weekly limit",
  "5-hour limit",
  "ไม่ได้รับ",
  "พื้นที่เก็บงาน",
  "ใช้งานหนัก",
  "ใบเสร็จ",
  "รหัสผ่านใหม่",
  "กู้คืนไม่ได้",
  "กู้คืน",
  "ใช้งานต่อ",
  "กลับเป็น",
  "ยกเลิกการเชื่อมต่อ",
  "เชื่อมต่อ",
  "หลังจากนั้น",
  "พร้อมกัน",
  "โดยอัตโนมัติ",
  "การใช้งาน",
  "ประมวลรัษฎากร",
  "มีผลทันที",
  "มีผล",
  "ไม่ต้องติดตั้งโปรแกรม",
  "สร้างโปรเจกต์",
  "โดยไม่ต้องพิมพ์รหัสผ่าน",
  "จากเครื่องนั้น",
  "ลิงก์ยืนยันใหม่",
  "บัญชีเดียวกันนี้",
  "ใช้งานจริง",
  "ตกเป็นโมฆะ",
  "จ่ายเงิน",
  "ข้อมูลการชำระเงิน",
  "โปรเจกต์ในเบราว์เซอร์",
  "ให้บริการ",
  "ดูคลิปให้จบ",
  "อาจต้อง",
  "ถ่ายไม่ใช่ปัญหา",
  "ขอบคุณที่ทักมา",
  "ช้ากว่า",
  "ได้ชัด",
  "อีกรอบ",
  "หน้าความเป็นส่วนตัว",
  "เนื้อหาที่ AI สร้างขึ้น",
  "หยุดให้บริการ",
  "ชื่อหรืออีเมลของคุณ",
  "คลิปยาว",
  "ทีละงาน",
  "ทีละบรรทัด",
  "ลงคลิป",
  "ถูกถามซ้ำ",
  // Home, /scope, /pricing (final review): phrases a narrow column split.
  "แบบไหน",
  "แก้เอง",
  "ไม่กี่นาที",
  "ไม่กี่ไฟล์",
  "ใช้หมดแล้ว",
  "ทีละช่วง",
  "ฉากเดียว",
  "ถี่ขึ้น",
  "แม่นขึ้น",
  "ครั้งเดียว",
  "พร้อมกันได้",
  "ต่อเดือน",
  "สลับช็อต",
  "เรนเดอร์ซ้ำ",
  "คำถามที่พบบ่อย",
  "ยังแก้เอง",
  "ไม่ใช่สุ่มตัด",
  "อยู่ครบ",
  "ยังอยู่ครบ",
  "พื้นที่เก็บโปรเจกต์",
  "ต่อเนื่อง",
  "ใช้งานต่อเนื่อง",
  "ใช้ไม่ได้",
  "ตั้งแต่ต้นจนจบ",
  "สวยกว่า",
  "เกลางาน",
  // Account pages (final review): phrases the account cards split.
  "ส่วนการสร้างโปรเจกต์",
  "อยู่ในห้องตัดต่อ",
  "บนเว็บทั้งหมด",
  "“เข้าสู่ระบบด้วย Google” ได้",
  "จะแสดงรายละเอียด",
  "ต่ออายุในอีก",
  "ใช้ได้อีก",
  "จุดตัดแม่นขึ้น",
  "แพลนฟรี",
];

/** A number and its unit stay on one line ("10 GB", "499 บาท", "30 นาที"), and so
 * does a plan name with the value after it ("Starter 20 นาที"), an estimate
 * with its "ราว" ("ราว 22 คลิป", "Pro ราว 30 คลิป") and a limit with its
 * "ภายใน" ("ภายใน 10 GB"). */
const NUMBER_UNIT =
  "(?:(?:ฟรี|Lite|Starter|Pro|Studio|Agency|Max) )?(?:(?:ระดับละเอียด)?(?:ราว|ภายใน) )?\\d[\\d,.]*\\s(?:GB|MB|นาที|วินาที|บาท|คลิป|โปรเจกต์|งาน|วัน|ชั่วโมง|เดือน|ไฟล์|ปี)";

/** A date stays on one line: "31 ธ.ค. 2026", "26 กันยายน 2569", "13 ต.ค.". */
const DATE =
  "\\d{1,2} (?:ม\\.ค\\.|ก\\.พ\\.|มี\\.ค\\.|เม\\.ย\\.|พ\\.ค\\.|มิ\\.ย\\.|ก\\.ค\\.|ส\\.ค\\.|ก\\.ย\\.|ต\\.ค\\.|พ\\.ย\\.|ธ\\.ค\\.|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)(?: \\d{4})?";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = new RegExp(
  `(${DATE}|${NUMBER_UNIT}|${[...KEEP_TOGETHER].sort((a, b) => b.length - a.length).map(escape).join("|")})`,
  "g",
);

/**
 * Marks that never start a line: the repeat mark ๆ ("สั้น ๆ"), the "·"
 * between the items of a run ("ฟรี 10 นาที · Lite 10 นาที") and the dash that
 * opens an aside ("คลิปสั้น — ฟังฟุตเทจ"). The space before each becomes a
 * no-break space, which keeps it on the word before it.
 */
export const glueMarks = (text: string) => text.replace(/ ([ๆ·—])/g, "\u00a0$1");

/**
 * Words that lean on the next one — a line must not end right after them:
 * "และ", "การ", "ตาม" ("สคริปต์ และ / สไตล์", "ไม่มีการ / คืนเงิน"). Before a
 * space, the space becomes a no-break space; glued to the next Thai word, a
 * word joiner (U+2060, invisible) goes between them. Plain string work, the
 * same on the server and in the browser, so the text hydrates as rendered.
 * (keepThaiProse, server-only, glues its own list by segmenting the text.)
 */
const LEANING = /(และ|การ|ตาม)( (?=[\u0E01-\u0E2E\u0E40-\u0E44])|(?=[\u0E01-\u0E2E\u0E40-\u0E44]))/g;

export const glueLeaning = (text: string) =>
  text.replace(LEANING, (_match, word: string, space: string) => `${word}${space ? "\u00a0" : "\u2060"}`);

/**
 * Thai text with those words and number–unit pairs wrapped so a line never
 * ends inside them. The text is unchanged apart from the no-break spaces
 * before ๆ, "·" and "—" and after a leaning word, and the invisible word
 * joiners after one (the wrappers are plain spans), so copy, search and
 * screen readers see the same words.
 */
export function keepThai(source: string): ReactNode {
  const text = glueMarks(source);
  const parts = text.split(PATTERN);
  if (parts.length === 1) return glueLeaning(text);
  // The leaning words are glued in the text between the kept runs only (a
  // joiner inside a kept phrase would stop it matching); one at the end of a
  // stretch is glued to the run after it by looking at that run's first letter.
  const between = (part: string, index: number) => {
    const next = parts[index + 1]?.[0] ?? "";
    const glued = glueLeaning(part + next);
    return next ? glued.slice(0, -next.length) : glued;
  };
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="kt">
        {part}
      </span>
    ) : part ? (
      <Fragment key={index}>{between(part, index)}</Fragment>
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
