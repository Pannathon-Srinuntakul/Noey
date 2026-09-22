/**
 * "What the product does and does not do" — the honest-scope copy shared by
 * the home page teaser and /scope. Text is the designer's (Website v2,
 * 2026-09-22). Keep it product-agnostic and never name an AI vendor.
 */

/** Home teaser: work the draft suits. */
export const HOME_FITS: readonly string[] = [
  "คลิปรีวิวและคลิปพูดหน้ากล้อง ที่โครงเรื่องไม่ซับซ้อน",
  "ไลฟ์หรือคลิปยาว ที่อยากตัดช่วงที่พูดได้ดีมาลงเป็นคลิปสั้น",
  "งานที่ถ่ายเองลงเอง ต้องการความเร็วมากกว่าความเป๊ะทุกเฟรม",
];

/** Home teaser: what the system cannot do yet. */
export const HOME_MISFITS: readonly string[] = [
  "แทรกภาพนิ่งหรือ B-roll ตามเนื้อหาที่พูดให้อัตโนมัติ",
  "ตัดซ้อนหลายชั้น สลับหลายกล้อง หรือคุมจังหวะแบบมิวสิกวิดีโอ",
  "งานโปรดักชันใหญ่ที่ต้องคุมทุกเฟรม",
];

/** /scope: the three steps the system finishes before you open the timeline. */
export const SCOPE_STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "ถอดเสียงทั้งกอง",
    body: "ฟุตเทจทุกไฟล์ในโปรเจกต์ถูกถอดเป็นข้อความพร้อมเวลา คุณอ่านได้ทั้งหมดก่อนตัดสินใจ",
  },
  {
    title: "คัดช็อตและเรียงลำดับ",
    body: "เลือกช่วงที่เนื้อหาต่อกันได้ ตัดช่วงเงียบและช่วงพูดพลาดออก แล้วเรียงเป็นร่างแรก",
  },
  {
    title: "ใส่ซับไทยให้",
    body: "ซับไทยตรงตามที่พูด แบ่งบรรทัดตามจังหวะพูด แก้ข้อความและตำแหน่งเองได้ในไทม์ไลน์",
  },
];

/** /scope: the editing that stays yours, in two columns. */
export const SCOPE_YOUR_WORK: ReadonlyArray<ReadonlyArray<{ title: string; body: string }>> = [
  [
    { title: "จังหวะเข้าออกของแต่ละช็อต", body: "ร่างแรกมักตัดตรงตามเสียง ซึ่งยังไม่ใช่จังหวะที่ดูลื่นที่สุด" },
    { title: "ลำดับการเล่าเรื่อง", body: "ระบบเรียงตามเนื้อหา แต่คุณอาจอยากขึ้นต้นด้วยประโยคที่ฮุกกว่า" },
  ],
  [
    { title: "คำในซับที่ต้องเป๊ะ", body: "ชื่อสินค้า ชื่อแบรนด์ และคำเฉพาะ ควรอ่านทวนอีกรอบก่อนลง" },
    { title: "เลือกทิ้งช็อตที่ภาพไม่สวย", body: "ระบบตัดสินจากเสียงเป็นหลัก ไม่ได้ตัดสินว่าภาพช่วงนั้นใช้ได้ไหม" },
  ],
];

/** /scope: work it suits. */
export const SCOPE_FITS: readonly string[] = [
  "คลิปรีวิวสินค้าและคลิปพูดหน้ากล้อง",
  "ไลฟ์หรือคลิปยาว ที่อยากตัดช่วงดี ๆ มาลงเป็นคลิปสั้น",
  "คลิปสั้นลง TikTok หรือ Reels จากฟุตเทจไม่กี่ไฟล์",
  "คลิปที่ถ่ายมาแบบไม่พูด แล้วมาพากย์ทับทีหลัง",
  "งานที่ถ่ายเองลงเอง ต้องการความเร็วมากกว่าความเป๊ะทุกเฟรม",
];

/** /scope: work it does not suit yet. */
export const SCOPE_MISFITS: readonly string[] = [
  "งานที่ต้องแทรกภาพนิ่งหรือ B-roll ตามบททีละช่วง",
  "ตัดซ้อนหลายชั้น หรือสลับหลายกล้องในฉากเดียว",
  "มิวสิกวิดีโอหรืองานที่ต้องคุมจังหวะตามบีต",
  "กราฟิก โมชัน และเอฟเฟกต์ภาพ ยังไม่มีในระบบ",
  "โปรดักชันที่ต้องคุมทุกเฟรม — ควรใช้โปรแกรมตัดต่อเต็มรูปแบบ",
];

/** /scope: the short summary card. */
export const SCOPE_SUMMARY: ReadonlyArray<{ label: string; text: string }> = [
  { label: "ระบบทำ", text: "ถอดเสียง คัดช็อต เรียงลำดับ ใส่ซับไทย" },
  { label: "คุณทำ", text: "เกลาจังหวะ ลำดับ และคำในซับ" },
  { label: "ยังไม่มี", text: "B-roll ตามบท ตัดซ้อน กราฟิกและเอฟเฟกต์" },
];
