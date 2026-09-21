/**
 * FAQ content — one array per page, used for BOTH the visible <details> list
 * and that page's FAQPage JSON-LD. Schema text is therefore always identical
 * to what a visitor reads (Google's FAQ guideline, and an AEO requirement).
 *
 * Text is the designer's. The designer's own JSON-LD used shortened answers
 * that did not match the visible ones; that drift is gone by construction.
 */

export interface FaqItem {
  question: string;
  answer: string;
}

export const HOME_FAQ: readonly FaqItem[] = [
  {
    question: "ต้องติดตั้งโปรแกรมไหม",
    answer:
      "ไม่ต้อง เปิดผ่าน Chrome หรือ Edge เวอร์ชันใหม่บนคอมพิวเตอร์ได้เลย ตอนนี้ยังแนะนำให้ใช้บนคอม เพราะการเรนเดอร์ใช้กำลังเครื่องพอสมควร",
  },
  {
    question: "รองรับไฟล์แบบไหนบ้าง",
    answer:
      "MP4 และ MOV จากมือถือและกล้องทั่วไปใช้ได้เลย ถ้าเป็นฟอร์แมตที่เบราว์เซอร์เปิดไม่ได้ ระบบจะแปลงให้ก่อนแล้วค่อยเริ่มงาน",
  },
  {
    question: "ถ้า AI ตัดมาไม่ถูกใจ แก้เองได้ไหม",
    answer:
      "ได้ทุกจุด ไทม์ไลน์เปิดให้แก้มือ ทั้งย้าย ยืดหด ลบ ทำซ้ำ หรือสลับช็อตในฉากเดิม แล้วเรนเดอร์ใหม่ได้ไม่จำกัดครั้ง",
  },
  {
    question: "คลิปยาวแค่ไหนถึงจะใช้ได้",
    answer:
      "ขึ้นกับแพลน แพลนฟรีรับฟุตเทจรวม 5 นาทีต่อโปรเจกต์ Lite 10 นาที Starter 20 นาที ส่วน Pro และ Studio สูงสุด 2 ชั่วโมงต่อโปรเจกต์ ดูรายละเอียดได้ในหน้าราคา",
  },
  {
    question: "ต้องใช้คอมแรงแค่ไหน",
    answer:
      "คอมทั่วไปที่รัน Chrome เวอร์ชันใหม่ได้ก็พอ เครื่องที่แรงกว่าจะเรนเดอร์เสร็จเร็วกว่า และคลิปยิ่งยาวก็ยิ่งใช้เวลานานขึ้นตามส่วน",
  },
];

export const PRICING_FAQ: readonly FaqItem[] = [
  {
    question: "ใช้แพลนฟรีได้นานแค่ไหน",
    answer: "ไม่มีกำหนด ใช้ต่อเนื่องได้ตามโควตาแต่ละรอบ ถ้าเริ่มไม่พอค่อยขยับขึ้น Starter หรือ Pro",
  },
  {
    question: "เปลี่ยนแพลนกลางเดือนได้ไหม",
    answer: "ได้ อัปเกรดแล้วโควตาใหม่มีผลทันที ส่วนการลดแพลนจะมีผลในรอบบิลถัดไป",
  },
  {
    question: "ยกเลิกแล้วเสียเงินเพิ่มไหม",
    answer:
      "ไม่เสีย ยกเลิกได้เองในหน้าตั้งค่า ใช้งานต่อได้จนจบรอบบิลที่จ่ายไปแล้ว จากนั้นบัญชีจะกลับไปเป็นแพลนฟรี",
  },
  {
    question: "จ่ายเงินยังไง",
    answer: "บัตรเครดิตหรือเดบิต ตัดอัตโนมัติทุกเดือน ออกใบเสร็จให้ทางอีเมล",
  },
];
