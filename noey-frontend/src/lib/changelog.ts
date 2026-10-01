/**
 * /changelog — "มีอะไรใหม่": what changed in Noey Studio, newest first.
 *
 * One entry per change a user can see. Add a new entry at the TOP and move
 * `PAGES.changelog.updated` to its date (a test checks they agree).
 *
 * Rules for the words (the repo's UI rules, the site's honesty rule):
 * - never name an AI vendor or model — say what the user gets instead;
 * - only what has shipped, never a promise; no measured-looking numbers that
 *   were not measured;
 * - say which plans have it when not every plan does.
 */
export type ChangeKind = "feature" | "improve" | "fix" | "pricing";

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  feature: "ฟีเจอร์ใหม่",
  improve: "ปรับปรุง",
  fix: "แก้ไข",
  pricing: "ราคาและแพลน",
};

export interface ChangelogEntry {
  /** Stable anchor: `#<id>` links to the entry and is its feed id. */
  id: string;
  /** ISO date (YYYY-MM-DD) the change reached users. */
  date: string;
  kind: ChangeKind;
  title: string;
  /** Two to four short paragraphs: what changed, how to use it. */
  body: readonly string[];
  /** Which plans have it, when not all of them do. */
  plans?: string;
  /** Where to read more on the site. */
  link?: { href: string; label: string };
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    // Shipped with the billing change of 2026-10-01 (owner's decisions,
    // docs/token-billing-design.md §24–§25), live from 2026-10-02.
    id: "weekly-limit-and-overage",
    date: "2026-10-02",
    kind: "pricing",
    title: "โควตารายสัปดาห์สำหรับ Pro ขึ้นไป และงานที่เริ่มแล้วไม่ถูกตัดกลางทาง",
    body: [
      "แพลน Pro, Studio, Agency และ Max มีโควตารายสัปดาห์เพิ่ม เท่ากับ 40% ของโควตารายเดือน นับ 7 วันตั้งแต่งานแรกที่ใช้ เพดานไหนเต็มก่อน งานใหม่จะรอจนเพดานนั้นเริ่มรอบใหม่ จำนวนคลิปต่อเดือนเท่าเดิม Lite และ Starter ยังมีโควตารายเดือนอย่างเดียว",
      "ก่อนเริ่มงาน ระบบเช็กว่าโควตาที่เหลือพอไหม ถ้าไม่พอ งานจะยังไม่เริ่ม และแนะนำทางเลือก เช่น ใช้คลิปที่สั้นลง ขอผลลัพธ์ที่สั้นลง อัปเกรด หรือเติมเงิน ส่วนงานที่เริ่มแล้ว ขั้นที่ AI กำลังทำจะทำจนเสร็จเสมอ ถ้าใช้เกินที่เหลือ ส่วนที่เกินนับรวมในรอบถัดไป เช่น ใช้ไป 106% รอบถัดไปเริ่มที่ 6% ไม่เรียกเก็บเป็นเงิน แล้วงานหยุดพักไว้ให้ทำต่อจากจุดเดิม",
      "อัปเกรดแล้วเริ่มรอบบิลใหม่วันนั้น โควตาเริ่มนับจาก 0% และจ่ายแค่ส่วนต่าง การลดแพลนยังมีผลเมื่อจบรอบบิลเหมือนเดิม",
      "โหมดตัดฉากเด่นได้คลิปผลลัพธ์ยาวไม่เกิน 5 นาทีต่อโปรเจกต์ ฟุตเทจดิบยังยาวได้ตามเพดานของแพลน",
    ],
    plans: "โควตารายสัปดาห์มีเฉพาะแพลน Pro, Studio, Agency และ Max",
    link: { href: "/pricing#quota-title", label: "อ่านวิธีคิดโควตา" },
  },
  {
    id: "beat-sync-web",
    date: "2026-10-01",
    kind: "feature",
    title: "ตัดตามจังหวะเพลงบนเว็บ",
    body: [
      "ในโหมดตัดฉากเด่น ถ้าใส่เพลงประกอบ เปิด \"ตัดตามจังหวะ\" ได้แล้วในห้องตัดต่อบนเว็บ ระบบวางจุดตัดของแต่ละช็อตให้ลงจังหวะเพลง",
      "สวิตช์อยู่ในขั้นเลือกผลลัพธ์ ข้างไฟล์เพลงที่เลือก",
    ],
    plans: "เพลงประกอบใช้ได้ตั้งแต่แพลน Lite ขึ้นไป",
    link: { href: "/guide/ai-cut-tiktok#voice", label: "อ่านเรื่องเสียงในคลิปแต่ละโหมด" },
  },
  {
    id: "honest-clip-counts",
    date: "2026-10-01",
    kind: "pricing",
    title: "จำนวนคลิปต่อเดือนคิดจากต้นทุนจริง และโควตารายเดือนรอบเดียว",
    body: [
      "ตัวเลขคลิปต่อเดือนของทุกแพลนคิดใหม่จากต้นทุนจริงของคลิปดิบ 5 นาทีและปัดลงเสมอ แพลนใหญ่ขึ้นได้คลิปต่อบาทมากขึ้น",
      "แพลน Pro ขึ้นไปบอกจำนวนที่ระดับละเอียดไว้ด้วย เพราะระดับละเอียดใช้โควตามากกว่า",
      "ทุกแพลนรายเดือนเหลือโควตารอบเดียวคือรายเดือน ได้ใหม่ทุกรอบบิล ไม่มีเพดานรายสัปดาห์หรือรายชั่วโมงแล้ว",
    ],
    link: { href: "/pricing", label: "ดูราคาและตารางเทียบแพลน" },
  },
  {
    id: "google-sign-in",
    date: "2026-09-30",
    kind: "feature",
    title: "เข้าสู่ระบบด้วย Google และลบบัญชีเองได้",
    body: [
      "สมัครหรือเข้าสู่ระบบด้วยบัญชี Google ได้ทั้งบนเว็บไซต์และในห้องตัดต่อ บัญชีที่สมัครด้วยอีเมลไว้แล้วผูก Google เพิ่มได้จากหน้าข้อมูลส่วนตัว",
      "ลบบัญชีได้เองจากหน้าข้อมูลส่วนตัว ระบบบอกก่อนว่าอะไรถูกลบและอะไรถูกเก็บไว้ตามกฎหมาย",
    ],
  },
  {
    id: "open-editor-signed-in",
    date: "2026-09-30",
    kind: "improve",
    title: "เปิดห้องตัดต่อจากเว็บไซต์ได้ทันที ไม่ต้องเข้าสู่ระบบซ้ำ",
    body: ["กด \"เปิดห้องตัดต่อ\" จากเว็บไซต์ตอนเข้าสู่ระบบอยู่ ห้องตัดต่อจะเปิดในบัญชีเดียวกันเลย"],
  },
  {
    id: "beta-pricing",
    date: "2026-09-30",
    kind: "pricing",
    title: "ราคาช่วงเบต้า ลด 50% ทุกแพลนรายเดือน",
    body: [
      "ช่วงเบต้าทุกแพลนรายเดือนลด 50% ถึง 31 ธ.ค. 2026 หลังจากนั้นรอบบิลถัดไปคิดราคาปกติทุกบัญชี รวมคนที่สมัครไว้แล้ว",
    ],
    link: { href: "/pricing", label: "ดูราคา" },
  },
  {
    id: "quota-percent-precision",
    date: "2026-09-30",
    kind: "improve",
    title: "โควตาแสดงเป็นเปอร์เซ็นต์ และเลือกระดับความละเอียดได้",
    body: [
      "หน้าตั้งค่าและหน้าบัญชีแสดงโควตาที่ใช้ไปเป็นเปอร์เซ็นต์ของรอบ และก่อนเริ่มงานทุกครั้งระบบบอกว่างานนั้นใช้โควตาเท่าไหร่",
      "แพลน Pro ขึ้นไปเลือกระดับละเอียดได้ ระบบดูคลิปถี่ขึ้นและวางจุดตัดแม่นขึ้น แลกกับการใช้โควตามากกว่า",
    ],
  },
  {
    id: "resume-paused-run",
    date: "2026-09-26",
    kind: "improve",
    title: "งานที่หยุดเพราะโควตาหมด ทำต่อจากจุดเดิมได้",
    body: [
      "ถ้าโควตาหมดระหว่างที่ระบบกำลังตัด งานจะหยุดพักไว้และเก็บส่วนที่ทำเสร็จแล้ว พอได้โควตาใหม่ กดทำต่อแล้วระบบเริ่มจากขั้นที่ค้างอยู่ ไม่ต้องจ่ายโควตาซ้ำกับส่วนที่เสร็จแล้ว",
    ],
  },
  {
    id: "longform-length",
    date: "2026-09-23",
    kind: "improve",
    title: "ตัดไฮไลต์จากคลิปยาว: AI กำหนดความยาวแต่ละคลิปตามเนื้อหา",
    body: [
      "โหมดตัดไฮไลต์จากคลิปยาวไม่ต้องตั้งความยาวไว้ล่วงหน้าแล้ว ระบบเลือกช่วงที่ดูจบได้ในตัวเอง แล้วตัดแต่ละคลิปยาวเท่าที่เนื้อหาช่วงนั้นต้องการ",
    ],
    link: { href: "/guide/long-to-shorts", label: "อ่านคู่มือตัดคลิปยาวเป็นคลิปสั้น" },
  },
];

/** The newest entry's date: the page's "อัปเดตล่าสุด". */
export const CHANGELOG_UPDATED = CHANGELOG.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), "");
